"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback, useMemo } from "react"
import { Contract, JsonRpcProvider } from "ethers"
import { Group } from "@semaphore-protocol/core"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { generateProofInBrowser } from "@/lib/proof"
import { eciesEncrypt, eciesDecrypt, encodeVotePayload, decodeVotePayload, compressPublicKey } from "@/lib/ecies"
import { CONTRACTS, SPECTRE_VOTING_ABI, SEMAPHORE_ABI, SEPOLIA_RPC } from "@/lib/contracts"
import { poseidon2 } from "poseidon-lite"
import Link from "next/link"
import { useSearchParams } from "next/navigation"

type Tab = "vote" | "results" | "manage"
type VoteStep = "idle" | "fetching-group" | "generating-proof" | "encrypting" | "submitting" | "done" | "error"
type TallyStep = "idle" | "fetching" | "decrypting" | "done" | "error"

interface DecryptedVote {
    nullifierHash: string
    vote: bigint
    voteRandomness: bigint
    commitmentValid: boolean
}

interface TallyResult {
    votesFor: number
    votesAgainst: number
    totalValid: number
    totalInvalid: number
    duplicatesRemoved: number
    decryptedVotes: DecryptedVote[]
}

interface ElectionState {
    proposalId: string
    votingOpen: boolean
    voteCount: number
    groupId: string
    admin: string
    electionPubKeyX: string
    electionPubKeyY: string
    votingDeadline: number
}

interface ElectionMeta {
    title: string
    yesLabel: string
    noLabel: string
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
    const [selectedVote, setSelectedVote] = useState<0 | 1 | null>(null)
    const [voteStep, setVoteStep] = useState<VoteStep>("idle")
    const [stepMsg, setStepMsg] = useState("")
    const [txHash, setTxHash] = useState("")
    const [error, setError] = useState("")

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
    // Read from URL params first (shared links), then localStorage, then defaults
    const meta: ElectionMeta = useMemo(() => {
        const urlTitle = searchParams.get("t")
        const urlYes = searchParams.get("y")
        const urlNo = searchParams.get("n")

        // Check localStorage for admin-stored metadata
        let stored: Partial<ElectionMeta> = {}
        try {
            stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
        } catch { /* ignore */ }

        // If we got URL params, also save them to localStorage for future visits
        if (urlTitle && !stored.title) {
            const m = { title: urlTitle, yesLabel: urlYes || "Yes", noLabel: urlNo || "No" }
            localStorage.setItem(`spectre-election-meta-${electionAddress}`, JSON.stringify(m))
        }

        return {
            title: urlTitle || stored.title || "",
            yesLabel: urlYes || stored.yesLabel || "Yes",
            noLabel: urlNo || stored.noLabel || "No",
        }
    }, [searchParams, electionAddress])

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(""), 2000)
    }

    // Load election state
    const refresh = useCallback(async () => {
        try {
            const provider = new JsonRpcProvider(SEPOLIA_RPC)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const [pid, open, vc, gid, admin, pkX, pkY, dl] = await Promise.all([
                c.proposalId(), c.votingOpen(), c.voteCount(), c.groupId(),
                c.admin(), c.electionPubKeyX(), c.electionPubKeyY(), c.votingDeadline(),
            ])
            setState({
                proposalId: pid.toString(), votingOpen: open, voteCount: Number(vc),
                groupId: gid.toString(), admin, electionPubKeyX: pkX.toString(), electionPubKeyY: pkY.toString(),
                votingDeadline: Number(dl),
            })
        } catch (err: any) {
            addLog(`Failed to load election: ${err.message}`)
        } finally { setLoading(false) }
    }, [electionAddress, addLog])

    useEffect(() => { refresh() }, [refresh])

    // ── VOTE LOGIC ──
    const castVote = useCallback(async () => {
        if (!identity || !signer || selectedVote === null || !state) return
        setError(""); setTxHash("")
        try {
            setVoteStep("fetching-group"); setStepMsg("Fetching voter group...")
            addLog("Fetching group members...")

            const provider = new JsonRpcProvider(SEPOLIA_RPC)
            const sem = new Contract(CONTRACTS.SEMAPHORE, SEMAPHORE_ABI, provider)
            const gid = BigInt(state.groupId)

            // RPC nodes limit getLogs to ~50k blocks, so query recent blocks only
            const currentBlock = await provider.getBlockNumber()
            const fromBlock = Math.max(0, currentBlock - 49000)

            const [singles, bulks] = await Promise.all([
                sem.queryFilter(sem.filters.MemberAdded(gid), fromBlock),
                sem.queryFilter(sem.filters.MembersAdded(gid), fromBlock),
            ])

            const members: { index: number; commitment: string }[] = []
            for (const e of singles) { const a = (e as any).args; members.push({ index: Number(a.index), commitment: a.identityCommitment.toString() }) }
            for (const e of bulks) { const a = (e as any).args; const si = Number(a.startIndex); for (let i = 0; i < a.identityCommitments.length; i++) members.push({ index: si + i, commitment: a.identityCommitments[i].toString() }) }
            members.sort((a, b) => a.index - b.index)

            const group = new Group()
            for (const m of members) group.addMember(BigInt(m.commitment))

            addLog(`Group: ${members.length} member(s)`)
            if (group.indexOf(identity.commitment) === -1) throw new Error("Your identity is not registered in this election. Ask the admin to add your Voter ID.")

            setVoteStep("generating-proof"); setStepMsg("Generating ZK proof (10-30s)...")
            addLog("Generating proof...")

            const rnd = randomBytes(31)
            let voteRand = 0n
            for (const b of rnd) voteRand = (voteRand << 8n) | BigInt(b)

            const proof = await generateProofInBrowser(identity, group, BigInt(state.proposalId), BigInt(selectedVote), voteRand)
            addLog(`Proof ready`)

            setVoteStep("encrypting"); setStepMsg("Encrypting vote...")
            const pubKey = compressPublicKey(BigInt(state.electionPubKeyX), BigInt(state.electionPubKeyY))
            const payload = encodeVotePayload(BigInt(selectedVote), voteRand)
            const blob = eciesEncrypt(pubKey, payload)

            setVoteStep("submitting"); setStepMsg("Confirm in your wallet...")
            const contract = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await contract.castVote(proof.pA, proof.pB, proof.pC, proof.merkleRoot, proof.nullifierHash, proof.voteCommitment, blob)
            setStepMsg("Waiting for confirmation...")
            const receipt = await tx.wait()

            setTxHash(tx.hash); setVoteStep("done"); setStepMsg("")
            addLog(`Vote confirmed in block ${receipt.blockNumber}`)
            await refresh()
        } catch (err: any) {
            const msg = err.reason || err.message || "Unknown error"
            setError(msg); setVoteStep("error"); setStepMsg("")
            addLog(`Error: ${msg}`)
        }
    }, [identity, signer, selectedVote, state, electionAddress, addLog, refresh])

    // ── ADMIN LOGIC ──
    const registerVoter = useCallback(async () => {
        if (!signer || !commitment.trim()) return
        setAdminLoading(true); setAdminMsg("")
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.registerVoter(commitment.trim())
            await tx.wait()
            setAdminMsg(`Voter registered!`)
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

    const closeVoting = useCallback(async () => {
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
        setTallyError(""); setTallyResult(null)
        const keyHex = privKeyHex || localStorage.getItem(`spectre-election-key-${electionAddress}`)
        if (!keyHex) {
            setTallyError("No election key found. Paste it below or open this page in the browser that created the election.")
            setTallyStep("error")
            return
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
                setTallyResult({ votesFor: 0, votesAgainst: 0, totalValid: 0, totalInvalid: 0, duplicatesRemoved: 0, decryptedVotes: [] })
                setTallyStep("done"); setTallyMsg("")
                return
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

            const byNullifier = new Map<string, DecryptedVote>()
            let duplicatesRemoved = 0
            for (const dv of decryptedVotes) {
                if (byNullifier.has(dv.nullifierHash)) duplicatesRemoved++
                byNullifier.set(dv.nullifierHash, dv)
            }

            const uniqueVotes = Array.from(byNullifier.values())
            let votesFor = 0, votesAgainst = 0, totalInvalid = 0
            for (const dv of uniqueVotes) {
                if (!dv.commitmentValid) totalInvalid++
                else if (dv.vote === 1n) votesFor++
                else if (dv.vote === 0n) votesAgainst++
                else totalInvalid++
            }

            setTallyResult({ votesFor, votesAgainst, totalValid: votesFor + votesAgainst, totalInvalid, duplicatesRemoved, decryptedVotes: uniqueVotes })
            setTallyStep("done"); setTallyMsg("")
            addLog(`Tally: ${votesFor} ${meta.yesLabel} / ${votesAgainst} ${meta.noLabel}`)
        } catch (err: any) {
            setTallyError(err.message || "Tally failed"); setTallyStep("error"); setTallyMsg("")
        }
    }, [electionAddress, addLog, meta.yesLabel, meta.noLabel])

    // ── SHARE ──
    const shareUrl = useMemo(() => {
        const base = typeof window !== "undefined" ? window.location.origin : ""
        let url = `${base}/election/${electionAddress}`
        if (meta.title) url += `?t=${encodeURIComponent(meta.title)}&y=${encodeURIComponent(meta.yesLabel)}&n=${encodeURIComponent(meta.noLabel)}`
        return url
    }, [electionAddress, meta])

    // Derived state
    const isAdmin = address && state?.admin && address.toLowerCase() === state.admin.toLowerCase()
    const hasPubKey = state ? (state.electionPubKeyX !== "0" || state.electionPubKeyY !== "0") : false
    const isProcessing = voteStep !== "idle" && voteStep !== "done" && voteStep !== "error"
    const displayTitle = meta.title || (state ? `Proposal #${state.proposalId}` : "Election")

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
                    <span className={`status-badge ${state.votingOpen ? "status-open" : "status-closed"}`}>
                        {state.votingOpen ? "OPEN" : "CLOSED"}
                    </span>
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: "0.8rem", color: "var(--text-muted)", flexWrap: "wrap", alignItems: "center" }}>
                    <span>{state.voteCount} vote{state.voteCount !== 1 ? "s" : ""}</span>
                    {state.votingDeadline > 0 && (
                        <span>
                            {Date.now() / 1000 > state.votingDeadline
                                ? "Deadline passed"
                                : `Closes ${new Date(state.votingDeadline * 1000).toLocaleString()}`}
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

            {/* Tabs — hide Manage from non-admins */}
            <div className="nav" style={{ marginBottom: 16 }}>
                <button onClick={() => setTab("vote")} className={tab === "vote" ? "active" : ""}>Vote</button>
                <button onClick={() => setTab("results")} className={tab === "results" ? "active" : ""}>Results</button>
                {isAdmin && (
                    <button onClick={() => setTab("manage")} className={tab === "manage" ? "active" : ""}>Manage</button>
                )}
            </div>

            {/* ═══ VOTE TAB ═══ */}
            {tab === "vote" && (
                <>
                    {/* Step 1: Identity */}
                    {!identity && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Step 1: Create Identity</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
                                Generate an anonymous identity to vote. This stays in your browser — nobody can link it to you.
                            </p>
                            <button className="btn-primary" onClick={createIdentity}>Create Identity</button>
                        </div>
                    )}

                    {/* Step 2: Wallet */}
                    {identity && !address && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Step 2: Connect Wallet</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
                                Connect to submit your vote on-chain. Your wallet is only used for the transaction — your vote stays anonymous.
                            </p>
                            <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 200 }}>Connect Wallet</button>
                        </div>
                    )}

                    {/* Step 3: Voter ID notice (if identity exists but might not be registered) */}
                    {identity && address && state.votingOpen && voteStep === "idle" && (
                        <div className="card" style={{ marginBottom: 16, background: "var(--bg)" }}>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                Your Voter ID:{" "}
                                <code className="mono" style={{ fontSize: "0.65rem" }}>
                                    {identity.commitment.toString().slice(0, 16)}...
                                </code>
                                {" "}
                                <button
                                    onClick={() => copyToClipboard(identity.commitment.toString(), "vid")}
                                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.8rem", cursor: "pointer", padding: 0 }}
                                >
                                    {copied === "vid" ? "Copied!" : "Copy full ID"}
                                </button>
                            </p>
                            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                                Send this to the election admin so they can register you to vote.
                            </p>
                        </div>
                    )}

                    {/* Vote card */}
                    <div className="card" style={{ marginBottom: 16 }}>
                        {!state.votingOpen && (
                            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "12px 0" }}>
                                Voting is closed. Check the Results tab.
                            </p>
                        )}

                        {state.votingOpen && (
                            <>
                                <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                                    <div
                                        className={`vote-option ${selectedVote === 1 ? "selected" : ""}`}
                                        onClick={() => !isProcessing && identity && address && setSelectedVote(1)}
                                        style={{ opacity: (!identity || !address || isProcessing) ? 0.4 : 1, cursor: (!identity || !address) ? "not-allowed" : "pointer" }}
                                    >
                                        {meta.yesLabel}
                                    </div>
                                    <div
                                        className={`vote-option ${selectedVote === 0 ? "selected" : ""}`}
                                        onClick={() => !isProcessing && identity && address && setSelectedVote(0)}
                                        style={{ opacity: (!identity || !address || isProcessing) ? 0.4 : 1, cursor: (!identity || !address) ? "not-allowed" : "pointer" }}
                                    >
                                        {meta.noLabel}
                                    </div>
                                </div>

                                {isProcessing && (
                                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: 14, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                        <div className="spinner" />
                                        <div>
                                            <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>{stepMsg}</p>
                                            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                                {voteStep === "generating-proof" && "Computing zero-knowledge proof..."}
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
                                        <p style={{ color: "var(--error)", fontWeight: 600, marginBottom: 4 }}>Vote Failed</p>
                                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{error}</p>
                                    </div>
                                )}

                                <button className="btn-primary" onClick={castVote}
                                    disabled={!identity || !address || !signer || !hasPubKey || selectedVote === null || isProcessing}>
                                    {isProcessing ? "Processing..." : voteStep === "done" ? "Vote Submitted!" : "Cast Vote"}
                                </button>

                                {(voteStep === "done" || voteStep === "error") && (
                                    <button className="btn-secondary" onClick={() => { setVoteStep("idle"); setSelectedVote(null); setTxHash(""); setError("") }} style={{ marginTop: 8 }}>
                                        {voteStep === "done" ? "Vote Again" : "Try Again"}
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </>
            )}

            {/* ═══ RESULTS TAB ═══ */}
            {tab === "results" && (
                <>
                    {!tallyResult && tallyStep !== "done" && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Decrypt &amp; Tally</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 14 }}>
                                {state.votingOpen
                                    ? "Voting is still open. You can preview interim results."
                                    : "Voting is closed. Decrypt all votes to see the final result."}
                            </p>

                            {hasStoredKey ? (
                                <p style={{ fontSize: "0.8rem", color: "var(--success)", marginBottom: 12 }}>
                                    ✓ Election key found in this browser
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
                                    {state.votingOpen ? "Interim Results" : "Final Results"}
                                </h4>

                                {tallyResult.totalValid === 0 ? (
                                    <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", padding: "20px 0" }}>No valid votes</p>
                                ) : (
                                    <>
                                        <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
                                            <div style={{ flex: 1, textAlign: "center" }}>
                                                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--success)" }}>
                                                    {tallyResult.votesFor}
                                                </div>
                                                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--success)", marginBottom: 8 }}>{meta.yesLabel}</div>
                                                <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
                                                    <div style={{ height: "100%", width: `${(tallyResult.votesFor / tallyResult.totalValid) * 100}%`, background: "var(--success)", borderRadius: 3, transition: "width 0.5s ease" }} />
                                                </div>
                                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                                                    {((tallyResult.votesFor / tallyResult.totalValid) * 100).toFixed(1)}%
                                                </div>
                                            </div>
                                            <div style={{ flex: 1, textAlign: "center" }}>
                                                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--error)" }}>
                                                    {tallyResult.votesAgainst}
                                                </div>
                                                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--error)", marginBottom: 8 }}>{meta.noLabel}</div>
                                                <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
                                                    <div style={{ height: "100%", width: `${(tallyResult.votesAgainst / tallyResult.totalValid) * 100}%`, background: "var(--error)", borderRadius: 3, transition: "width 0.5s ease" }} />
                                                </div>
                                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                                                    {((tallyResult.votesAgainst / tallyResult.totalValid) * 100).toFixed(1)}%
                                                </div>
                                            </div>
                                        </div>

                                        {!state.votingOpen && tallyResult.votesFor !== tallyResult.votesAgainst && (
                                            <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: tallyResult.votesFor > tallyResult.votesAgainst ? "#22c55e10" : "#ef444410", border: `1px solid ${tallyResult.votesFor > tallyResult.votesAgainst ? "#22c55e40" : "#ef444440"}`, marginBottom: 12 }}>
                                                <span style={{ fontWeight: 700, color: tallyResult.votesFor > tallyResult.votesAgainst ? "var(--success)" : "var(--error)" }}>
                                                    {tallyResult.votesFor > tallyResult.votesAgainst ? `${meta.yesLabel} wins` : `${meta.noLabel} wins`}
                                                </span>
                                                <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginLeft: 8 }}>
                                                    by {Math.abs(tallyResult.votesFor - tallyResult.votesAgainst)} vote{Math.abs(tallyResult.votesFor - tallyResult.votesAgainst) !== 1 ? "s" : ""}
                                                </span>
                                            </div>
                                        )}

                                        {!state.votingOpen && tallyResult.votesFor === tallyResult.votesAgainst && tallyResult.totalValid > 0 && (
                                            <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: "var(--bg-hover)", border: "1px solid var(--border)", marginBottom: 12 }}>
                                                <span style={{ fontWeight: 700, color: "var(--warning)" }}>Tie</span>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            {/* Stats */}
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
                                                            <span style={{ fontWeight: 700, fontSize: "0.75rem", color: dv.vote === 1n ? "var(--success)" : "var(--error)" }}>
                                                                {dv.vote === 1n ? meta.yesLabel : meta.noLabel}
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
                    {/* Share link prominently */}
                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Share Election</h4>
                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                            Send this link to your voters. They&apos;ll be guided through identity setup and voting.
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

                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Register Voter</h4>
                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                            Paste the Voter ID that each voter copies from their identity card.
                        </p>
                        <div style={{ display: "flex", gap: 8 }}>
                            <input placeholder="Voter ID (commitment)" value={commitment} onChange={e => setCommitment(e.target.value)} disabled={adminLoading} style={{ flex: 1 }} />
                            <button className="btn-primary" onClick={registerVoter} disabled={adminLoading || !commitment.trim() || !state.votingOpen} style={{ width: "auto", padding: "12px 18px" }}>
                                {adminLoading ? "..." : "Add"}
                            </button>
                        </div>
                    </div>

                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>Bulk Register</h4>
                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                            Add multiple voters at once. One Voter ID per line.
                        </p>
                        <textarea placeholder={"One Voter ID per line..."} value={bulkCommitments} onChange={e => setBulkCommitments(e.target.value)} disabled={adminLoading} rows={3}
                            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", padding: "10px 14px", fontFamily: "inherit", fontSize: "0.85rem", resize: "vertical", outline: "none", marginBottom: 8 }} />
                        <button className="btn-primary" onClick={registerBulk} disabled={adminLoading || !bulkCommitments.trim() || !state.votingOpen}>
                            {adminLoading ? "Processing..." : "Register All"}
                        </button>
                    </div>

                    {state.votingOpen && (
                        <div className="card" style={{ borderColor: "var(--error)" }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8, color: "var(--error)" }}>Close Voting</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>Permanently close this election. No more votes will be accepted.</p>
                            <button className="btn-secondary" onClick={closeVoting} disabled={adminLoading} style={{ borderColor: "var(--error)", color: "var(--error)" }}>
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
