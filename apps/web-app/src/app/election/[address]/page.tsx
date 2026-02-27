"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback, useMemo } from "react"
import { Contract, JsonRpcProvider } from "ethers"
import { Identity, Group } from "@semaphore-protocol/core"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { generateProofInBrowser } from "@/lib/proof"
import { generateAnonJoinProof } from "@/lib/anonJoinProof"
import { eciesEncrypt, eciesDecrypt, encodeVotePayload, decodeVotePayload, compressPublicKey } from "@/lib/ecies"
import { CONTRACTS, SPECTRE_VOTING_ABI, SEMAPHORE_ABI, SEPOLIA_RPC } from "@/lib/contracts"
import { poseidon2 } from "poseidon-lite"
import Link from "next/link"
import { useSearchParams } from "next/navigation"

type Tab = "vote" | "results" | "manage"
type Phase = "signup" | "voting" | "closed"
type VoteStep = "idle" | "fetching-signup-group" | "generating-join-proof" | "submitting-join" | "fetching-voting-group" | "generating-vote-proof" | "encrypting" | "submitting-vote" | "done" | "error"
type TallyStep = "idle" | "fetching" | "decrypting" | "done" | "error"

interface DecryptedVote {
    nullifierHash: string
    vote: bigint
    voteRandomness: bigint
    commitmentValid: boolean
}

interface TallyResult {
    optionCounts: number[]
    totalValid: number
    totalInvalid: number
    duplicatesRemoved: number
    decryptedVotes: DecryptedVote[]
}

interface ElectionState {
    proposalId: string
    signupOpen: boolean
    votingOpen: boolean
    voteCount: number
    signupGroupId: string
    votingGroupId: string
    admin: string
    electionPubKeyX: string
    electionPubKeyY: string
    signupDeadline: number
    votingDeadline: number
    numOptions: number
}

interface ElectionMeta {
    title: string
    labels: string[]
}

/** Get members from a Semaphore group by querying events */
async function fetchGroupMembers(groupId: bigint): Promise<bigint[]> {
    const provider = new JsonRpcProvider(SEPOLIA_RPC)
    const sem = new Contract(CONTRACTS.SEMAPHORE, SEMAPHORE_ABI, provider)
    const currentBlock = await provider.getBlockNumber()
    const fromBlock = Math.max(0, currentBlock - 49000)

    const [singles, bulks] = await Promise.all([
        sem.queryFilter(sem.filters.MemberAdded(groupId), fromBlock),
        sem.queryFilter(sem.filters.MembersAdded(groupId), fromBlock),
    ])

    const members: { index: number; commitment: string }[] = []
    for (const e of singles) {
        const a = (e as any).args
        members.push({ index: Number(a.index), commitment: a.identityCommitment.toString() })
    }
    for (const e of bulks) {
        const a = (e as any).args
        const si = Number(a.startIndex)
        for (let i = 0; i < a.identityCommitments.length; i++) {
            members.push({ index: si + i, commitment: a.identityCommitments[i].toString() })
        }
    }
    members.sort((a, b) => a.index - b.index)
    return members.map(m => BigInt(m.commitment))
}

export default function ElectionPage({ params }: { params: { address: string } }) {
    const electionAddress = params.address
    const searchParams = useSearchParams()
    const { identity, createIdentity, address, signer, connectWallet, addLog } = useSpectre()

    const [tab, setTab] = useState<Tab>("vote")
    const [state, setState] = useState<ElectionState | null>(null)
    const [loading, setLoading] = useState(true)
    const [copied, setCopied] = useState("")

    // Vote state
    const [selectedVote, setSelectedVote] = useState<number | null>(null)
    const [voteStep, setVoteStep] = useState<VoteStep>("idle")
    const [stepMsg, setStepMsg] = useState("")
    const [txHash, setTxHash] = useState("")
    const [error, setError] = useState("")

    // Signup state
    const [signupLoading, setSignupLoading] = useState(false)
    const [signupStatus, setSignupStatus] = useState<"unknown" | "checking" | "signed-up" | "not-signed-up">("unknown")

    // Join state (has voter already anonymously joined?)
    const [joinStatus, setJoinStatus] = useState<"unknown" | "checking" | "joined" | "not-joined">("unknown")

    // Admin state
    const [commitment, setCommitment] = useState("")
    const [bulkCommitments, setBulkCommitments] = useState("")
    const [adminLoading, setAdminLoading] = useState(false)
    const [adminMsg, setAdminMsg] = useState("")

    // Tally state
    const [tallyStep, setTallyStep] = useState<TallyStep>("idle")
    const [tallyMsg, setTallyMsg] = useState("")
    const [tallyResult, setTallyResult] = useState<TallyResult | null>(null)
    const [tallyError, setTallyError] = useState("")
    const [manualKeyInput, setManualKeyInput] = useState("")

    // ── ELECTION METADATA ──
    const meta: ElectionMeta = useMemo(() => {
        const urlTitle = searchParams.get("t")
        const urlLabels = searchParams.get("labels")
        // Backwards compat: old format used y= and n=
        const urlYes = searchParams.get("y")
        const urlNo = searchParams.get("n")

        let stored: Partial<ElectionMeta> = {}
        try {
            stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
        } catch { /* ignore */ }

        let labels: string[]
        if (urlLabels) {
            labels = urlLabels.split(",").map(l => l.trim()).filter(Boolean)
        } else if (urlYes || urlNo) {
            labels = [urlYes || "Yes", urlNo || "No"]
        } else if (stored.labels && stored.labels.length > 0) {
            labels = stored.labels
        } else {
            labels = []
        }

        const title = urlTitle || stored.title || ""

        // Save to localStorage if from URL
        if ((urlTitle || urlLabels) && !stored.title) {
            localStorage.setItem(`spectre-election-meta-${electionAddress}`, JSON.stringify({ title, labels }))
        }

        return { title, labels }
    }, [searchParams, electionAddress])

    const displayTitle = meta.title || (state ? `Proposal #${state.proposalId}` : "Election")

    // Option labels: use meta labels, fall back to "Option 0", "Option 1", etc.
    const optionLabels = useMemo(() => {
        if (!state) return []
        const labels: string[] = []
        for (let i = 0; i < state.numOptions; i++) {
            labels.push(meta.labels[i] || `Option ${i}`)
        }
        return labels
    }, [state, meta.labels])

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(""), 2000)
    }

    // ── Determine current phase ──
    const phase: Phase = useMemo(() => {
        if (!state) return "closed"
        if (state.signupOpen) return "signup"
        if (state.votingOpen) return "voting"
        return "closed"
    }, [state])

    // ── Voting identity for this election ──
    // Per-election identity stored separately from the global signup identity
    const votingIdentityKey = `spectre-voting-identity-${electionAddress}`

    const getVotingIdentity = useCallback((): Identity | null => {
        try {
            const saved = localStorage.getItem(votingIdentityKey)
            if (saved) return Identity.import(saved)
        } catch { /* ignore */ }
        return null
    }, [votingIdentityKey])

    const createVotingIdentity = useCallback((): Identity => {
        const id = new Identity()
        localStorage.setItem(votingIdentityKey, id.export())
        return id
    }, [votingIdentityKey])

    // Load election state
    const refresh = useCallback(async () => {
        try {
            const provider = new JsonRpcProvider(SEPOLIA_RPC)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const [pid, sOpen, vOpen, vc, sgid, vgid, admin, pkX, pkY, sdl, vdl, numOpt] = await Promise.all([
                c.proposalId(), c.signupOpen(), c.votingOpen(), c.voteCount(),
                c.signupGroupId(), c.votingGroupId(),
                c.admin(), c.electionPubKeyX(), c.electionPubKeyY(),
                c.signupDeadline(), c.votingDeadline(), c.numOptions(),
            ])
            setState({
                proposalId: pid.toString(),
                signupOpen: sOpen,
                votingOpen: vOpen,
                voteCount: Number(vc),
                signupGroupId: sgid.toString(),
                votingGroupId: vgid.toString(),
                admin,
                electionPubKeyX: pkX.toString(),
                electionPubKeyY: pkY.toString(),
                signupDeadline: Number(sdl),
                votingDeadline: Number(vdl),
                numOptions: Number(numOpt),
            })
        } catch (err: any) {
            addLog(`Failed to load election: ${err.message}`)
        } finally { setLoading(false) }
    }, [electionAddress, addLog])

    useEffect(() => { refresh() }, [refresh])

    // ── CHECK SIGNUP STATUS ──
    const checkSignup = useCallback(async () => {
        if (!identity || !state) return
        setSignupStatus("checking")
        try {
            const members = await fetchGroupMembers(BigInt(state.signupGroupId))
            const found = members.some(m => m.toString() === identity.commitment.toString())
            setSignupStatus(found ? "signed-up" : "not-signed-up")
        } catch (err: any) {
            addLog(`Signup check failed: ${err.message}`)
            setSignupStatus("unknown")
        }
    }, [identity, state, addLog])

    useEffect(() => {
        if (identity && state && phase === "signup") checkSignup()
    }, [identity, state, phase, checkSignup])

    // ── CHECK JOIN STATUS ──
    const checkJoinStatus = useCallback(async () => {
        if (!state) return
        const votingId = getVotingIdentity()
        if (!votingId) { setJoinStatus("not-joined"); return }
        setJoinStatus("checking")
        try {
            const members = await fetchGroupMembers(BigInt(state.votingGroupId))
            const found = members.some(m => m.toString() === votingId.commitment.toString())
            setJoinStatus(found ? "joined" : "not-joined")
        } catch {
            setJoinStatus("unknown")
        }
    }, [state, getVotingIdentity])

    useEffect(() => {
        if (state && phase === "voting") checkJoinStatus()
    }, [state, phase, checkJoinStatus])

    // ── SIGNUP (Phase 1) ──
    const handleSignUp = useCallback(async () => {
        if (!identity || !signer || !state) return
        setSignupLoading(true)
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.signUp(identity.commitment)
            await tx.wait()
            addLog("Signed up for election!")
            setSignupStatus("signed-up")
            await refresh()
        } catch (err: any) {
            addLog(`Signup failed: ${err.reason || err.message}`)
        } finally { setSignupLoading(false) }
    }, [identity, signer, state, electionAddress, addLog, refresh])

    // ── ANONYMOUS JOIN + VOTE (Phase 2) ──
    const handleJoinAndVote = useCallback(async () => {
        if (!identity || !signer || selectedVote === null || !state) return
        setError(""); setTxHash("")
        try {
            // Step 1: Check if we need to anonymous join first
            let votingId = getVotingIdentity()
            const needsJoin = joinStatus !== "joined"

            if (needsJoin) {
                // Create per-election voting identity if not exists
                if (!votingId) {
                    votingId = createVotingIdentity()
                    addLog("Created per-election voting identity")
                }

                setVoteStep("fetching-signup-group"); setStepMsg("Fetching signup group...")
                const signupMembers = await fetchGroupMembers(BigInt(state.signupGroupId))
                const signupGroup = new Group()
                for (const m of signupMembers) signupGroup.addMember(m)
                addLog(`Signup group: ${signupMembers.length} member(s)`)

                if (signupGroup.indexOf(identity.commitment) === -1) {
                    throw new Error("Your identity is not in the signup group. Did you sign up during Phase 1?")
                }

                setVoteStep("generating-join-proof"); setStepMsg("Generating anonymous join proof (10-30s)...")
                addLog("Generating AnonJoin proof...")
                const joinProof = await generateAnonJoinProof(identity, votingId, signupGroup, BigInt(state.proposalId))
                addLog("AnonJoin proof ready")

                setVoteStep("submitting-join"); setStepMsg("Confirm anonymous join in wallet...")
                const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
                const joinTx = await c.anonJoin(
                    joinProof.pA, joinProof.pB, joinProof.pC,
                    joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
                )
                setStepMsg("Waiting for join confirmation...")
                await joinTx.wait()
                addLog("Anonymous join confirmed! Identity delinked.")
                setJoinStatus("joined")
            } else {
                if (!votingId) throw new Error("No voting identity found. This shouldn't happen.")
            }

            // Step 2: Cast vote
            setVoteStep("fetching-voting-group"); setStepMsg("Fetching voting group...")
            const votingMembers = await fetchGroupMembers(BigInt(state.votingGroupId))
            const votingGroup = new Group()
            for (const m of votingMembers) votingGroup.addMember(m)
            addLog(`Voting group: ${votingMembers.length} member(s)`)

            if (votingGroup.indexOf(votingId!.commitment) === -1) {
                throw new Error("Your voting identity is not in the voting group yet. Try refreshing.")
            }

            setVoteStep("generating-vote-proof"); setStepMsg("Generating vote proof (10-30s)...")
            addLog("Generating SpectreVote proof...")

            const rnd = randomBytes(31)
            let voteRand = 0n
            for (const b of rnd) voteRand = (voteRand << 8n) | BigInt(b)

            const proof = await generateProofInBrowser(
                votingId!, votingGroup, BigInt(state.proposalId),
                BigInt(selectedVote), voteRand, BigInt(state.numOptions)
            )
            addLog("Vote proof ready")

            setVoteStep("encrypting"); setStepMsg("Encrypting vote...")
            const pubKey = compressPublicKey(BigInt(state.electionPubKeyX), BigInt(state.electionPubKeyY))
            const payload = encodeVotePayload(BigInt(selectedVote), voteRand)
            const blob = eciesEncrypt(pubKey, payload)

            setVoteStep("submitting-vote"); setStepMsg("Confirm vote in wallet...")
            const contract = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await contract.castVote(
                proof.pA, proof.pB, proof.pC,
                proof.merkleRoot, proof.nullifierHash, proof.voteCommitment, blob
            )
            setStepMsg("Waiting for vote confirmation...")
            const receipt = await tx.wait()

            setTxHash(tx.hash); setVoteStep("done"); setStepMsg("")
            addLog(`Vote confirmed in block ${receipt.blockNumber}`)
            await refresh()
        } catch (err: any) {
            const msg = err.reason || err.message || "Unknown error"
            setError(msg); setVoteStep("error"); setStepMsg("")
            addLog(`Error: ${msg}`)
        }
    }, [identity, signer, selectedVote, state, electionAddress, addLog, refresh, joinStatus, getVotingIdentity, createVotingIdentity])

    // ── ADMIN LOGIC ──
    const registerVoter = useCallback(async () => {
        if (!signer || !commitment.trim()) return
        setAdminLoading(true); setAdminMsg("")
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.registerVoter(commitment.trim())
            await tx.wait()
            setAdminMsg("Voter registered!")
            setCommitment(""); await refresh()
        } catch (err: any) { setAdminMsg(`Error: ${err.reason || err.message}`) }
        finally { setAdminLoading(false) }
    }, [signer, commitment, electionAddress, refresh])

    const registerBulk = useCallback(async () => {
        if (!signer || !bulkCommitments.trim()) return
        setAdminLoading(true); setAdminMsg("")
        try {
            const list = bulkCommitments.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.registerVoters(list)
            await tx.wait()
            setAdminMsg(`${list.length} voters registered!`)
            setBulkCommitments(""); await refresh()
        } catch (err: any) { setAdminMsg(`Error: ${err.reason || err.message}`) }
        finally { setAdminLoading(false) }
    }, [signer, bulkCommitments, electionAddress, refresh])

    const handleCloseSignup = useCallback(async () => {
        if (!signer) return
        setAdminLoading(true); setAdminMsg("")
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.closeSignup()
            await tx.wait()
            setAdminMsg("Signup closed! Voting is now open."); await refresh()
        } catch (err: any) { setAdminMsg(`Error: ${err.reason || err.message}`) }
        finally { setAdminLoading(false) }
    }, [signer, electionAddress, refresh])

    const handleCloseVoting = useCallback(async () => {
        if (!signer) return
        setAdminLoading(true); setAdminMsg("")
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.closeVoting()
            await tx.wait()
            setAdminMsg("Voting closed!"); await refresh()
        } catch (err: any) { setAdminMsg(`Error: ${err.reason || err.message}`) }
        finally { setAdminLoading(false) }
    }, [signer, electionAddress, refresh])

    // ── TALLY LOGIC ──
    const hasStoredKey = typeof window !== "undefined" && !!localStorage.getItem(`spectre-election-key-${electionAddress}`)

    const runTally = useCallback(async (privKeyHex?: string) => {
        if (!state) return
        setTallyError(""); setTallyResult(null)
        const keyHex = privKeyHex || localStorage.getItem(`spectre-election-key-${electionAddress}`)
        if (!keyHex) {
            setTallyError("No election key found. Paste it below or open this page in the browser that created the election.")
            setTallyStep("error"); return
        }

        try {
            const electionPrivKey = new Uint8Array(32)
            for (let i = 0; i < 32; i++) {
                electionPrivKey[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16)
            }

            setTallyStep("fetching"); setTallyMsg("Fetching votes from chain...")

            const provider = new JsonRpcProvider(SEPOLIA_RPC)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const currentBlock = await provider.getBlockNumber()
            const fromBlock = Math.max(0, currentBlock - 49000)
            const events = await c.queryFilter(c.filters.VoteCast(), fromBlock)

            if (events.length === 0) {
                setTallyResult({ optionCounts: new Array(state.numOptions).fill(0), totalValid: 0, totalInvalid: 0, duplicatesRemoved: 0, decryptedVotes: [] })
                setTallyStep("done"); setTallyMsg(""); return
            }

            setTallyStep("decrypting"); setTallyMsg(`Decrypting ${events.length} vote(s)...`)

            const decryptedVotes: DecryptedVote[] = []
            for (const event of events) {
                const args = (event as any).args
                const nullifierHash = args.nullifierHash.toString()
                const voteCommitment = args.voteCommitment.toString()
                const encryptedBlob = args.encryptedBlob

                const blobHex = encryptedBlob.startsWith("0x") ? encryptedBlob.slice(2) : encryptedBlob
                const blob = new Uint8Array(blobHex.length / 2)
                for (let i = 0; i < blob.length; i++) {
                    blob[i] = parseInt(blobHex.substring(i * 2, i * 2 + 2), 16)
                }

                try {
                    const plaintext = eciesDecrypt(electionPrivKey, blob)
                    const { vote, voteRandomness } = decodeVotePayload(plaintext)
                    const recomputed = poseidon2([vote, voteRandomness])
                    const commitmentValid = recomputed.toString() === voteCommitment
                    decryptedVotes.push({ nullifierHash, vote, voteRandomness, commitmentValid })
                } catch {
                    decryptedVotes.push({ nullifierHash, vote: -1n, voteRandomness: 0n, commitmentValid: false })
                }
            }

            electionPrivKey.fill(0)

            // Dedup by nullifier
            const byNullifier = new Map<string, DecryptedVote>()
            let duplicatesRemoved = 0
            for (const dv of decryptedVotes) {
                if (byNullifier.has(dv.nullifierHash)) duplicatesRemoved++
                byNullifier.set(dv.nullifierHash, dv)
            }

            const uniqueVotes = Array.from(byNullifier.values())
            const optionCounts = new Array(state.numOptions).fill(0)
            let totalInvalid = 0

            for (const dv of uniqueVotes) {
                if (!dv.commitmentValid || dv.vote < 0n || Number(dv.vote) >= state.numOptions) {
                    totalInvalid++
                } else {
                    optionCounts[Number(dv.vote)]++
                }
            }

            const totalValid = optionCounts.reduce((a: number, b: number) => a + b, 0)

            setTallyResult({ optionCounts, totalValid, totalInvalid, duplicatesRemoved, decryptedVotes: uniqueVotes })
            setTallyStep("done"); setTallyMsg("")

            const summary = optionCounts.map((c: number, i: number) => `${optionLabels[i] || `Option ${i}`}: ${c}`).join(", ")
            addLog(`Tally: ${summary}`)
        } catch (err: any) {
            setTallyError(err.message || "Tally failed"); setTallyStep("error"); setTallyMsg("")
        }
    }, [electionAddress, addLog, state, optionLabels])

    // ── SHARE ──
    const shareUrl = useMemo(() => {
        const base = typeof window !== "undefined" ? window.location.origin : ""
        let url = `${base}/election/${electionAddress}`
        const params: string[] = []
        if (meta.title) params.push(`t=${encodeURIComponent(meta.title)}`)
        if (meta.labels.length > 0) params.push(`labels=${encodeURIComponent(meta.labels.join(","))}`)
        if (params.length > 0) url += `?${params.join("&")}`
        return url
    }, [electionAddress, meta])

    // Derived
    const isAdmin = address && state?.admin && address.toLowerCase() === state.admin.toLowerCase()
    const hasPubKey = state ? (state.electionPubKeyX !== "0" || state.electionPubKeyY !== "0") : false
    const isProcessing = !["idle", "done", "error"].includes(voteStep)

    // Phase badge color
    const phaseBadge = phase === "signup" ? { text: "SIGNUP", cls: "status-open" }
        : phase === "voting" ? { text: "VOTING", cls: "status-open" }
        : { text: "CLOSED", cls: "status-closed" }

    if (loading) return (
        <div style={{ textAlign: "center", padding: 48 }}>
            <div className="spinner" style={{ margin: "0 auto 12px" }} />
            <p style={{ color: "var(--text-muted)" }}>Loading election...</p>
        </div>
    )

    if (!state) return (
        <div className="card" style={{ textAlign: "center" }}>
            <p style={{ color: "var(--error)" }}>Failed to load election at {electionAddress}</p>
            <Link href="/" style={{ display: "inline-block", marginTop: 12 }}>Back to elections</Link>
        </div>
    )

    return (
        <>
            {/* Header */}
            <div style={{ marginBottom: 12, fontSize: "0.8rem" }}>
                <Link href="/">← All Elections</Link>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <h2 style={{ fontSize: "1.1rem", fontWeight: 700, lineHeight: 1.3, flex: 1, marginRight: 12 }}>{displayTitle}</h2>
                    <span className={`status-badge ${phaseBadge.cls}`}>{phaseBadge.text}</span>
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: "0.8rem", color: "var(--text-muted)", flexWrap: "wrap", alignItems: "center" }}>
                    <span>{state.voteCount} vote{state.voteCount !== 1 ? "s" : ""}</span>
                    <span>{state.numOptions} options</span>
                    {phase === "signup" && state.signupDeadline > 0 && (
                        <span>
                            {Date.now() / 1000 > state.signupDeadline
                                ? "Signup deadline passed"
                                : `Signup closes ${new Date(state.signupDeadline * 1000).toLocaleString()}`}
                        </span>
                    )}
                    {(phase === "voting" || phase === "closed") && state.votingDeadline > 0 && (
                        <span>
                            {Date.now() / 1000 > state.votingDeadline
                                ? "Voting deadline passed"
                                : `Voting closes ${new Date(state.votingDeadline * 1000).toLocaleString()}`}
                        </span>
                    )}
                    <button
                        onClick={() => copyToClipboard(shareUrl, "share")}
                        style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.8rem", cursor: "pointer", padding: 0 }}
                    >
                        {copied === "share" ? "Link copied!" : "Share link"}
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="nav" style={{ marginBottom: 16 }}>
                <button onClick={() => setTab("vote")} className={tab === "vote" ? "active" : ""}>
                    {phase === "signup" ? "Sign Up" : "Vote"}
                </button>
                <button onClick={() => setTab("results")} className={tab === "results" ? "active" : ""}>Results</button>
                {isAdmin && (
                    <button onClick={() => setTab("manage")} className={tab === "manage" ? "active" : ""}>Manage</button>
                )}
            </div>

            {/* ═══ VOTE/SIGNUP TAB ═══ */}
            {tab === "vote" && (
                <>
                    {/* Step 1: Wallet */}
                    {!address && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Step 1: Connect Wallet</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
                                Connect to submit transactions on-chain. Your wallet is only for gas — your vote stays anonymous.
                            </p>
                            <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 200 }}>Connect Wallet</button>
                        </div>
                    )}

                    {/* Step 2: Identity */}
                    {address && !identity && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Step 2: Create Identity</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
                                Generate an anonymous identity for this wallet. Each wallet gets its own identity — nobody can link it to your vote.
                            </p>
                            <button className="btn-primary" onClick={createIdentity}>Create Identity</button>
                        </div>
                    )}

                    {/* ── SIGNUP PHASE ── */}
                    {phase === "signup" && identity && address && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            {signupStatus === "checking" && (
                                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                    <div className="spinner" />
                                    <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Checking signup status...</p>
                                </div>
                            )}

                            {signupStatus === "signed-up" && (
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                    <span style={{ fontSize: "1.2rem", color: "var(--success)" }}>&#10003;</span>
                                    <div>
                                        <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>You&apos;re signed up!</p>
                                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                            Wait for the admin to close signup. Once voting opens, you&apos;ll anonymously join and cast your vote.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {(signupStatus === "not-signed-up" || signupStatus === "unknown") && (
                                <>
                                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>Sign Up to Vote</h4>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                        Register your identity for this election. This is public — the admin can see who signed up. But when voting opens, you&apos;ll use a ZK proof to anonymously re-key into the voting group. <strong>Nobody can link your signup to your vote.</strong>
                                    </p>
                                    <button
                                        className="btn-primary"
                                        onClick={handleSignUp}
                                        disabled={signupLoading}
                                    >
                                        {signupLoading ? "Signing up..." : "Sign Up"}
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    {/* ── VOTING PHASE ── */}
                    {phase === "voting" && identity && address && (
                        <>
                            {/* Join + vote status indicators */}
                            {voteStep === "idle" && joinStatus === "joined" && (
                                <div className="card" style={{ marginBottom: 16, borderColor: "#22c55e40", background: "#22c55e08" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <span style={{ fontSize: "1.2rem" }}>&#10003;</span>
                                        <div>
                                            <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>Anonymously joined</p>
                                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Your voting identity is delinked from signup. Select an option and cast your vote.</p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {voteStep === "idle" && joinStatus === "not-joined" && (
                                <div className="card" style={{ marginBottom: 16, background: "var(--bg)" }}>
                                    <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                                        When you cast your vote, you&apos;ll first anonymously re-key into the voting group (ZK proof), then submit your encrypted vote. This requires <strong>two wallet confirmations</strong>.
                                    </p>
                                </div>
                            )}

                            {/* Vote options */}
                            <div className="card" style={{ marginBottom: 16 }}>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
                                    {optionLabels.map((label, i) => (
                                        <div
                                            key={i}
                                            className={`vote-option ${selectedVote === i ? "selected" : ""}`}
                                            onClick={() => !isProcessing && setSelectedVote(i)}
                                            style={{
                                                opacity: isProcessing ? 0.4 : 1,
                                                cursor: isProcessing ? "not-allowed" : "pointer",
                                                flex: state.numOptions <= 3 ? "1" : "0 0 calc(50% - 6px)",
                                                minWidth: 0,
                                            }}
                                        >
                                            {label}
                                        </div>
                                    ))}
                                </div>

                                {/* Processing indicator */}
                                {isProcessing && (
                                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: 14, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                        <div className="spinner" />
                                        <div>
                                            <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>{stepMsg}</p>
                                            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                                {(voteStep === "generating-join-proof" || voteStep === "generating-vote-proof") && "Computing zero-knowledge proof..."}
                                                {voteStep === "encrypting" && "Encrypting your vote..."}
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {voteStep === "done" && txHash && (
                                    <div style={{ marginBottom: 16, padding: 14, background: "#22c55e10", borderRadius: "var(--radius)", border: "1px solid #22c55e40" }}>
                                        <p style={{ color: "var(--success)", fontWeight: 600, marginBottom: 4 }}>Vote submitted anonymously!</p>
                                        <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.75rem" }}>
                                            View on Etherscan →
                                        </a>
                                    </div>
                                )}

                                {voteStep === "error" && (
                                    <div style={{ marginBottom: 16, padding: 14, background: "#ef444410", borderRadius: "var(--radius)", border: "1px solid #ef444440" }}>
                                        <p style={{ color: "var(--error)", fontWeight: 600, marginBottom: 4 }}>Failed</p>
                                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{error}</p>
                                    </div>
                                )}

                                <button
                                    className="btn-primary"
                                    onClick={handleJoinAndVote}
                                    disabled={!hasPubKey || selectedVote === null || isProcessing}
                                >
                                    {isProcessing ? "Processing..." : voteStep === "done" ? "Vote Submitted!" :
                                        joinStatus === "joined" ? "Cast Vote" : "Join & Vote"}
                                </button>

                                {(voteStep === "done" || voteStep === "error") && (
                                    <button className="btn-secondary" onClick={() => { setVoteStep("idle"); setSelectedVote(null); setTxHash(""); setError("") }} style={{ marginTop: 8 }}>
                                        {voteStep === "done" ? "Vote Again" : "Try Again"}
                                    </button>
                                )}
                            </div>
                        </>
                    )}

                    {/* CLOSED phase message */}
                    {phase === "closed" && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "12px 0" }}>
                                Voting is closed. Check the Results tab.
                            </p>
                        </div>
                    )}
                </>
            )}

            {/* ═══ RESULTS TAB ═══ */}
            {tab === "results" && (
                <>
                    {!tallyResult && tallyStep !== "done" && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Decrypt &amp; Tally</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 14 }}>
                                {phase !== "closed"
                                    ? "Election is still active. You can preview interim results."
                                    : "Voting is closed. Decrypt all votes to see the final result."}
                            </p>

                            {hasStoredKey ? (
                                <p style={{ fontSize: "0.8rem", color: "var(--success)", marginBottom: 12 }}>
                                    Election key found in this browser
                                </p>
                            ) : (
                                <div style={{ marginBottom: 12 }}>
                                    <p style={{ fontSize: "0.8rem", color: "var(--warning)", marginBottom: 8 }}>
                                        No election key found. Paste the key from the browser that created this election:
                                    </p>
                                    <input
                                        placeholder="Election private key (64 hex chars)"
                                        value={manualKeyInput}
                                        onChange={e => setManualKeyInput(e.target.value)}
                                        style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "0.75rem" }}
                                    />
                                </div>
                            )}

                            {tallyStep !== "idle" && tallyStep !== "error" && (
                                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: 14, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                    <div className="spinner" />
                                    <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>{tallyMsg}</p>
                                </div>
                            )}

                            {tallyStep === "error" && (
                                <div style={{ marginBottom: 16, padding: 14, background: "#ef444410", borderRadius: "var(--radius)", border: "1px solid #ef444440" }}>
                                    <p style={{ color: "var(--error)", fontWeight: 600, marginBottom: 4 }}>Tally Failed</p>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{tallyError}</p>
                                </div>
                            )}

                            <button
                                className="btn-primary"
                                onClick={() => runTally(manualKeyInput || undefined)}
                                disabled={tallyStep === "fetching" || tallyStep === "decrypting" || (!hasStoredKey && !manualKeyInput.trim())}
                            >
                                {tallyStep === "fetching" || tallyStep === "decrypting" ? "Computing..." : "Tally Votes"}
                            </button>
                        </div>
                    )}

                    {tallyResult && (
                        <>
                            <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
                                <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                                    {phase === "closed" ? "Final Results" : "Interim Results"}
                                </h4>

                                {tallyResult.totalValid === 0 ? (
                                    <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", padding: "20px 0" }}>No valid votes</p>
                                ) : (
                                    <>
                                        {/* Per-option bars */}
                                        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
                                            {tallyResult.optionCounts.map((count: number, i: number) => {
                                                const pct = (count / tallyResult.totalValid) * 100
                                                const isWinner = count === Math.max(...tallyResult.optionCounts)
                                                const colors = ["var(--success)", "var(--error)", "var(--accent)", "var(--warning)", "#a855f7", "#06b6d4", "#f97316", "#ec4899"]
                                                const color = colors[i % colors.length]
                                                return (
                                                    <div key={i}>
                                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                                                            <span style={{ fontSize: "0.85rem", fontWeight: 600, color }}>{optionLabels[i]}</span>
                                                            <span style={{ fontSize: "1.1rem", fontWeight: 800, color }}>{count}</span>
                                                        </div>
                                                        <div style={{ height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden" }}>
                                                            <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4, transition: "width 0.5s ease" }} />
                                                        </div>
                                                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2, textAlign: "right" }}>
                                                            {pct.toFixed(1)}%
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>

                                        {/* Winner announcement */}
                                        {phase === "closed" && (() => {
                                            const maxCount = Math.max(...tallyResult.optionCounts)
                                            const winners = tallyResult.optionCounts.reduce((acc: number[], c: number, i: number) => c === maxCount ? [...acc, i] : acc, [])
                                            if (winners.length === 1) {
                                                const colors = ["var(--success)", "var(--error)", "var(--accent)", "var(--warning)", "#a855f7", "#06b6d4", "#f97316", "#ec4899"]
                                                return (
                                                    <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 12 }}>
                                                        <span style={{ fontWeight: 700, color: colors[winners[0] % colors.length] }}>
                                                            {optionLabels[winners[0]]} wins
                                                        </span>
                                                    </div>
                                                )
                                            } else if (winners.length > 1 && tallyResult.totalValid > 0) {
                                                return (
                                                    <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: "var(--bg-hover)", border: "1px solid var(--border)", marginBottom: 12 }}>
                                                        <span style={{ fontWeight: 700, color: "var(--warning)" }}>Tie</span>
                                                    </div>
                                                )
                                            }
                                            return null
                                        })()}
                                    </>
                                )}
                            </div>

                            {/* Audit stats */}
                            <div className="card" style={{ marginBottom: 16 }}>
                                <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Audit</h4>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: "0.85rem" }}>
                                    <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                        <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Valid</div>
                                        <div style={{ fontWeight: 700, color: "var(--success)" }}>{tallyResult.totalValid}</div>
                                    </div>
                                    <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                        <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Invalid</div>
                                        <div style={{ fontWeight: 700, color: tallyResult.totalInvalid > 0 ? "var(--error)" : "var(--text-muted)" }}>{tallyResult.totalInvalid}</div>
                                    </div>
                                    <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                        <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Duplicates Removed</div>
                                        <div style={{ fontWeight: 700 }}>{tallyResult.duplicatesRemoved}</div>
                                    </div>
                                    <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                        <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>On-chain Total</div>
                                        <div style={{ fontWeight: 700 }}>{state.voteCount}</div>
                                    </div>
                                </div>
                            </div>

                            {tallyResult.decryptedVotes.length > 0 && (
                                <div className="card" style={{ marginBottom: 16 }}>
                                    <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                                        Votes ({tallyResult.decryptedVotes.length})
                                    </h4>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                        {tallyResult.decryptedVotes.map((dv, i) => (
                                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", fontSize: "0.8rem" }}>
                                                <span className="mono" style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                                                    {dv.nullifierHash.slice(0, 10)}...{dv.nullifierHash.slice(-6)}
                                                </span>
                                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                                    {dv.commitmentValid ? (
                                                        <>
                                                            <span style={{ fontWeight: 700, fontSize: "0.75rem" }}>
                                                                {optionLabels[Number(dv.vote)] || `Option ${dv.vote}`}
                                                            </span>
                                                            <span style={{ fontSize: "0.65rem", color: "var(--success)" }}>✓</span>
                                                        </>
                                                    ) : (
                                                        <span style={{ fontWeight: 700, fontSize: "0.75rem", color: "var(--error)" }}>INVALID</span>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <button className="btn-secondary" onClick={() => { setTallyResult(null); setTallyStep("idle") }} style={{ marginBottom: 16 }}>
                                Re-tally
                            </button>
                        </>
                    )}
                </>
            )}

            {/* ═══ MANAGE TAB (admin only) ═══ */}
            {tab === "manage" && isAdmin && (
                <>
                    {/* Share link */}
                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Share Election</h4>
                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                            Send this link to voters. They can sign up directly during the signup phase.
                        </p>
                        <div style={{ display: "flex", gap: 8 }}>
                            <code className="mono" style={{ flex: 1, background: "var(--bg)", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.65rem" }}>
                                {shareUrl}
                            </code>
                            <button onClick={() => copyToClipboard(shareUrl, "share2")} className="btn-primary" style={{ width: "auto", padding: "10px 16px", fontSize: "0.8rem" }}>
                                {copied === "share2" ? "Copied!" : "Copy"}
                            </button>
                        </div>
                    </div>

                    {/* Admin register (during signup phase) */}
                    {phase === "signup" && (
                        <>
                            <div className="card" style={{ marginBottom: 16 }}>
                                <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Register Voter</h4>
                                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                                    Admin can also add voters directly. Paste their Voter ID.
                                </p>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <input placeholder="Voter ID (commitment)" value={commitment} onChange={e => setCommitment(e.target.value)} disabled={adminLoading} style={{ flex: 1 }} />
                                    <button className="btn-primary" onClick={registerVoter} disabled={adminLoading || !commitment.trim()} style={{ width: "auto", padding: "12px 18px" }}>
                                        {adminLoading ? "..." : "Add"}
                                    </button>
                                </div>
                            </div>

                            <div className="card" style={{ marginBottom: 16 }}>
                                <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Bulk Register</h4>
                                <textarea placeholder="One Voter ID per line..." value={bulkCommitments} onChange={e => setBulkCommitments(e.target.value)} disabled={adminLoading} rows={3}
                                    style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", padding: "10px 14px", fontFamily: "inherit", fontSize: "0.85rem", resize: "vertical", outline: "none", marginBottom: 8 }} />
                                <button className="btn-primary" onClick={registerBulk} disabled={adminLoading || !bulkCommitments.trim()}>
                                    {adminLoading ? "Processing..." : "Register All"}
                                </button>
                            </div>
                        </>
                    )}

                    {/* Close signup */}
                    {phase === "signup" && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Close Signup &amp; Open Voting</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                                Close registration and open the anonymous join + voting phase. Voters who signed up can now anonymously re-key and vote.
                            </p>
                            <button className="btn-primary" onClick={handleCloseSignup} disabled={adminLoading}>
                                {adminLoading ? "Closing..." : "Close Signup"}
                            </button>
                        </div>
                    )}

                    {/* Close voting */}
                    {phase === "voting" && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--error)" }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8, color: "var(--error)" }}>Close Voting</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>Permanently close this election. No more joins or votes will be accepted.</p>
                            <button className="btn-secondary" onClick={handleCloseVoting} disabled={adminLoading} style={{ borderColor: "var(--error)", color: "var(--error)" }}>
                                {adminLoading ? "Closing..." : "Close Voting"}
                            </button>
                        </div>
                    )}

                    {adminMsg && (
                        <div className="card" style={{ marginTop: 16, borderColor: adminMsg.startsWith("Error") ? "var(--error)" : "var(--success)" }}>
                            <p style={{ fontSize: "0.85rem", color: adminMsg.startsWith("Error") ? "var(--error)" : "var(--success)" }}>{adminMsg}</p>
                        </div>
                    )}
                </>
            )}

            {/* Info footer */}
            <div style={{ marginTop: 24, padding: "12px 0", borderTop: "1px solid var(--border)", textAlign: "center" }}>
                <a href={`https://sepolia.etherscan.io/address/${electionAddress}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                    Contract: {electionAddress.slice(0, 10)}...{electionAddress.slice(-8)}
                </a>
            </div>
        </>
    )
}
