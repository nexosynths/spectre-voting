"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback } from "react"
import { Contract, JsonRpcProvider } from "ethers"
import { Group } from "@semaphore-protocol/core"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { generateProofInBrowser } from "@/lib/proof"
import { eciesEncrypt, eciesDecrypt, encodeVotePayload, decodeVotePayload, compressPublicKey } from "@/lib/ecies"
import { CONTRACTS, SPECTRE_VOTING_ABI, SEMAPHORE_ABI, SEPOLIA_RPC } from "@/lib/contracts"
import { poseidon2 } from "poseidon-lite"
import Link from "next/link"

type Tab = "vote" | "admin" | "results"
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
    votingDeadline: number // unix timestamp, 0 = no deadline
}

export default function ElectionPage({ params }: { params: { address: string } }) {
    const electionAddress = params.address
    const { identity, address, signer, connectWallet, addLog } = useSpectre()

    const [tab, setTab] = useState<Tab>("vote")
    const [state, setState] = useState<ElectionState | null>(null)
    const [loading, setLoading] = useState(true)

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
            if (group.indexOf(identity.commitment) === -1) throw new Error("Your identity is not registered in this election")

            setVoteStep("generating-proof"); setStepMsg("Generating ZK proof (10-30s)...")
            addLog("Generating proof...")

            const rnd = randomBytes(31)
            let voteRand = 0n
            for (const b of rnd) voteRand = (voteRand << 8n) | BigInt(b)

            const proof = await generateProofInBrowser(identity, group, BigInt(state.proposalId), BigInt(selectedVote), voteRand)
            addLog(`Proof ready. Nullifier: ${proof.nullifierHash.slice(0, 12)}...`)

            setVoteStep("encrypting"); setStepMsg("Encrypting vote...")
            const pubKey = compressPublicKey(BigInt(state.electionPubKeyX), BigInt(state.electionPubKeyY))
            const payload = encodeVotePayload(BigInt(selectedVote), voteRand)
            const blob = eciesEncrypt(pubKey, payload)
            addLog(`Encrypted (${blob.length} bytes)`)

            setVoteStep("submitting"); setStepMsg("Submitting transaction...")
            const contract = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await contract.castVote(proof.pA, proof.pB, proof.pC, proof.merkleRoot, proof.nullifierHash, proof.voteCommitment, blob)
            addLog(`Tx: ${tx.hash.slice(0, 16)}...`)
            setStepMsg("Waiting for confirmation...")
            const receipt = await tx.wait()

            setTxHash(tx.hash); setVoteStep("done"); setStepMsg("")
            addLog(`Confirmed in block ${receipt.blockNumber}`)
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
            setAdminMsg(`Registered! Tx: ${tx.hash.slice(0, 16)}...`)
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

        // Resolve the election private key
        const keyHex = privKeyHex || localStorage.getItem(`spectre-election-key-${electionAddress}`)
        if (!keyHex) {
            setTallyError("No election private key found. Paste it below or run tally from the browser that created this election.")
            setTallyStep("error")
            return
        }

        try {
            // Parse private key from hex
            const electionPrivKey = new Uint8Array(32)
            for (let i = 0; i < 32; i++) {
                electionPrivKey[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16)
            }

            setTallyStep("fetching"); setTallyMsg("Fetching VoteCast events from chain...")
            addLog("Fetching all VoteCast events...")

            const provider = new JsonRpcProvider(SEPOLIA_RPC)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)

            // RPC nodes limit getLogs to ~50k blocks
            const currentBlock = await provider.getBlockNumber()
            const fromBlock = Math.max(0, currentBlock - 49000)
            const events = await c.queryFilter(c.filters.VoteCast(), fromBlock)

            addLog(`Found ${events.length} vote(s) on-chain`)

            if (events.length === 0) {
                setTallyResult({ votesFor: 0, votesAgainst: 0, totalValid: 0, totalInvalid: 0, duplicatesRemoved: 0, decryptedVotes: [] })
                setTallyStep("done"); setTallyMsg("")
                return
            }

            setTallyStep("decrypting"); setTallyMsg(`Decrypting ${events.length} vote(s)...`)

            // Decrypt and verify each vote
            const decryptedVotes: DecryptedVote[] = []
            for (const event of events) {
                const args = (event as any).args
                const nullifierHash = args.nullifierHash.toString()
                const voteCommitment = args.voteCommitment.toString()
                const encryptedBlob = args.encryptedBlob

                // Convert hex blob to Uint8Array
                const blobHex = encryptedBlob.startsWith("0x") ? encryptedBlob.slice(2) : encryptedBlob
                const blob = new Uint8Array(blobHex.length / 2)
                for (let i = 0; i < blob.length; i++) {
                    blob[i] = parseInt(blobHex.substring(i * 2, i * 2 + 2), 16)
                }

                try {
                    const plaintext = eciesDecrypt(electionPrivKey, blob)
                    const { vote, voteRandomness } = decodeVotePayload(plaintext)

                    // Verify: poseidon2(vote, randomness) == on-chain commitment
                    const recomputed = poseidon2([vote, voteRandomness])
                    const commitmentValid = recomputed.toString() === voteCommitment

                    decryptedVotes.push({ nullifierHash, vote, voteRandomness, commitmentValid })
                } catch {
                    // Decryption failed — corrupted or wrong key
                    decryptedVotes.push({ nullifierHash, vote: -1n, voteRandomness: 0n, commitmentValid: false })
                }
            }

            // Zero out the key from memory
            electionPrivKey.fill(0)

            // Deduplicate by nullifier (last submission wins)
            const byNullifier = new Map<string, DecryptedVote>()
            let duplicatesRemoved = 0
            for (const dv of decryptedVotes) {
                if (byNullifier.has(dv.nullifierHash)) duplicatesRemoved++
                byNullifier.set(dv.nullifierHash, dv)
            }

            // Count
            const uniqueVotes = Array.from(byNullifier.values())
            let votesFor = 0, votesAgainst = 0, totalInvalid = 0
            for (const dv of uniqueVotes) {
                if (!dv.commitmentValid) totalInvalid++
                else if (dv.vote === 1n) votesFor++
                else if (dv.vote === 0n) votesAgainst++
                else totalInvalid++
            }

            const result: TallyResult = {
                votesFor, votesAgainst,
                totalValid: votesFor + votesAgainst,
                totalInvalid, duplicatesRemoved,
                decryptedVotes: uniqueVotes,
            }

            setTallyResult(result)
            setTallyStep("done"); setTallyMsg("")
            addLog(`Tally complete: ${votesFor} YES / ${votesAgainst} NO (${totalInvalid} invalid, ${duplicatesRemoved} dupes removed)`)
        } catch (err: any) {
            const msg = err.message || "Tally failed"
            setTallyError(msg); setTallyStep("error"); setTallyMsg("")
            addLog(`Tally error: ${msg}`)
        }
    }, [electionAddress, addLog])

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

    const isAdmin = address && state.admin && address.toLowerCase() === state.admin.toLowerCase()
    const hasPubKey = state.electionPubKeyX !== "0" || state.electionPubKeyY !== "0"
    const isProcessing = voteStep !== "idle" && voteStep !== "done" && voteStep !== "error"

    return (
        <>
            {/* Breadcrumb */}
            <div style={{ marginBottom: 12, fontSize: "0.8rem" }}>
                <Link href="/">Elections</Link>
                <span style={{ color: "var(--text-muted)", margin: "0 8px" }}>/</span>
                <span style={{ color: "var(--text-muted)" }}>Proposal #{state.proposalId}</span>
            </div>

            {/* Election header */}
            <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h2 style={{ fontSize: "1.05rem", fontWeight: 700 }}>Proposal #{state.proposalId}</h2>
                    <span className={`status-badge ${state.votingOpen ? "status-open" : "status-closed"}`}>
                        {state.votingOpen ? "OPEN" : "CLOSED"}
                    </span>
                </div>
                <div style={{ display: "flex", gap: 20, fontSize: "0.8rem", color: "var(--text-muted)", flexWrap: "wrap" }}>
                    <span>{state.voteCount} vote{state.voteCount !== 1 ? "s" : ""}</span>
                    {state.votingDeadline > 0 && (
                        <span>
                            Deadline: {new Date(state.votingDeadline * 1000).toLocaleString()}
                            {Date.now() / 1000 > state.votingDeadline && " (expired)"}
                        </span>
                    )}
                    <span className="mono">Admin: {state.admin.slice(0, 6)}...{state.admin.slice(-4)}</span>
                    <a href={`https://sepolia.etherscan.io/address/${electionAddress}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.75rem" }}>
                        {electionAddress.slice(0, 8)}...{electionAddress.slice(-6)}
                    </a>
                </div>
            </div>

            {/* Tabs */}
            <div className="nav" style={{ marginBottom: 16 }}>
                <button onClick={() => setTab("vote")} className={tab === "vote" ? "active" : ""}>Vote</button>
                <button onClick={() => setTab("results")} className={tab === "results" ? "active" : ""}>Results</button>
                <button onClick={() => setTab("admin")} className={tab === "admin" ? "active" : ""}>Admin</button>
            </div>

            {/* ═══ VOTE TAB ═══ */}
            {tab === "vote" && (
                <>
                    {!identity && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--warning)" }}>
                            <p style={{ color: "var(--warning)", fontSize: "0.85rem" }}>
                                Generate a ZK identity first. <Link href="/">Go to home page</Link>
                            </p>
                        </div>
                    )}

                    {!address && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 10 }}>Connect wallet to submit votes</p>
                            <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 180 }}>Connect</button>
                        </div>
                    )}

                    {!hasPubKey && state.votingOpen && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--warning)" }}>
                            <p style={{ color: "var(--warning)", fontSize: "0.85rem" }}>Election keys not configured.</p>
                        </div>
                    )}

                    <div className="card" style={{ marginBottom: 16 }}>
                        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                            <div className={`vote-option ${selectedVote === 1 ? "selected" : ""}`} onClick={() => !isProcessing && setSelectedVote(1)} style={{ opacity: isProcessing ? 0.5 : 1 }}>YES</div>
                            <div className={`vote-option ${selectedVote === 0 ? "selected" : ""}`} onClick={() => !isProcessing && setSelectedVote(0)} style={{ opacity: isProcessing ? 0.5 : 1 }}>NO</div>
                        </div>

                        {isProcessing && (
                            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: 14, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                <div className="spinner" />
                                <div>
                                    <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>{stepMsg}</p>
                                    <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                        {voteStep === "generating-proof" && "Computing Groth16 proof (16k constraints)..."}
                                    </p>
                                </div>
                            </div>
                        )}

                        {voteStep === "done" && txHash && (
                            <div style={{ marginBottom: 16, padding: 14, background: "#22c55e10", borderRadius: "var(--radius)", border: "1px solid #22c55e40" }}>
                                <p style={{ color: "var(--success)", fontWeight: 600, marginBottom: 4 }}>Vote cast anonymously!</p>
                                <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.75rem" }}>
                                    Tx: {txHash.slice(0, 20)}...
                                </a>
                            </div>
                        )}

                        {voteStep === "error" && (
                            <div style={{ marginBottom: 16, padding: 14, background: "#ef444410", borderRadius: "var(--radius)", border: "1px solid #ef444440" }}>
                                <p style={{ color: "var(--error)", fontWeight: 600, marginBottom: 4 }}>Failed</p>
                                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{error}</p>
                            </div>
                        )}

                        <button className="btn-primary" onClick={castVote}
                            disabled={!(identity && address && signer && state.votingOpen && hasPubKey && selectedVote !== null && voteStep === "idle") && !isProcessing || isProcessing}>
                            {isProcessing ? "Processing..." : voteStep === "done" ? "Done!" : "Cast Vote"}
                        </button>

                        {(voteStep === "done" || voteStep === "error") && (
                            <button className="btn-secondary" onClick={() => { setVoteStep("idle"); setSelectedVote(null); setTxHash(""); setError("") }} style={{ marginTop: 8 }}>
                                {voteStep === "done" ? "Vote Again" : "Try Again"}
                            </button>
                        )}
                    </div>
                </>
            )}

            {/* ═══ RESULTS TAB ═══ */}
            {tab === "results" && (
                <>
                    {/* Tally controls */}
                    {!tallyResult && tallyStep !== "done" && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Decrypt &amp; Tally Votes</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 14 }}>
                                {state.votingOpen
                                    ? "Voting is still open. You can tally now to see interim results, but votes may still come in."
                                    : "Voting is closed. Decrypt all votes and compute the final result."}
                            </p>

                            {hasStoredKey ? (
                                <p style={{ fontSize: "0.8rem", color: "var(--success)", marginBottom: 12 }}>
                                    ✓ Election key found in this browser
                                </p>
                            ) : (
                                <div style={{ marginBottom: 12 }}>
                                    <p style={{ fontSize: "0.8rem", color: "var(--warning)", marginBottom: 8 }}>
                                        No election key found. Paste the hex private key from the browser that created this election:
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

                    {/* Results display */}
                    {tallyResult && (
                        <>
                            {/* Main result card */}
                            <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
                                <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                                    {state.votingOpen ? "Interim Results" : "Final Results"}
                                </h4>

                                {tallyResult.totalValid === 0 ? (
                                    <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", padding: "20px 0" }}>No valid votes</p>
                                ) : (
                                    <>
                                        {/* YES / NO bars */}
                                        <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
                                            <div style={{ flex: 1, textAlign: "center" }}>
                                                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--success)" }}>
                                                    {tallyResult.votesFor}
                                                </div>
                                                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--success)", marginBottom: 8 }}>YES</div>
                                                <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
                                                    <div style={{
                                                        height: "100%",
                                                        width: `${(tallyResult.votesFor / tallyResult.totalValid) * 100}%`,
                                                        background: "var(--success)",
                                                        borderRadius: 3,
                                                        transition: "width 0.5s ease",
                                                    }} />
                                                </div>
                                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                                                    {((tallyResult.votesFor / tallyResult.totalValid) * 100).toFixed(1)}%
                                                </div>
                                            </div>
                                            <div style={{ flex: 1, textAlign: "center" }}>
                                                <div style={{ fontSize: "2rem", fontWeight: 800, color: "var(--error)" }}>
                                                    {tallyResult.votesAgainst}
                                                </div>
                                                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--error)", marginBottom: 8 }}>NO</div>
                                                <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
                                                    <div style={{
                                                        height: "100%",
                                                        width: `${(tallyResult.votesAgainst / tallyResult.totalValid) * 100}%`,
                                                        background: "var(--error)",
                                                        borderRadius: 3,
                                                        transition: "width 0.5s ease",
                                                    }} />
                                                </div>
                                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                                                    {((tallyResult.votesAgainst / tallyResult.totalValid) * 100).toFixed(1)}%
                                                </div>
                                            </div>
                                        </div>

                                        {/* Winner banner */}
                                        {!state.votingOpen && tallyResult.votesFor !== tallyResult.votesAgainst && (
                                            <div style={{
                                                padding: "10px 16px",
                                                borderRadius: "var(--radius)",
                                                background: tallyResult.votesFor > tallyResult.votesAgainst ? "#22c55e10" : "#ef444410",
                                                border: `1px solid ${tallyResult.votesFor > tallyResult.votesAgainst ? "#22c55e40" : "#ef444440"}`,
                                                marginBottom: 12,
                                            }}>
                                                <span style={{ fontWeight: 700, color: tallyResult.votesFor > tallyResult.votesAgainst ? "var(--success)" : "var(--error)" }}>
                                                    {tallyResult.votesFor > tallyResult.votesAgainst ? "YES wins" : "NO wins"}
                                                </span>
                                                <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginLeft: 8 }}>
                                                    {Math.abs(tallyResult.votesFor - tallyResult.votesAgainst)} vote margin
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

                            {/* Stats card */}
                            <div className="card" style={{ marginBottom: 16 }}>
                                <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                                    Verification Summary
                                </h4>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: "0.85rem" }}>
                                    <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                        <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Total Valid</div>
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
                                        <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>On-chain Votes</div>
                                        <div style={{ fontWeight: 700 }}>{state.voteCount}</div>
                                    </div>
                                </div>
                            </div>

                            {/* Individual votes (anonymized) */}
                            {tallyResult.decryptedVotes.length > 0 && (
                                <div className="card" style={{ marginBottom: 16 }}>
                                    <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                                        Individual Votes ({tallyResult.decryptedVotes.length})
                                    </h4>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                        {tallyResult.decryptedVotes.map((dv, i) => (
                                            <div key={i} style={{
                                                display: "flex", justifyContent: "space-between", alignItems: "center",
                                                padding: "8px 12px", background: "var(--bg)", borderRadius: 8,
                                                border: "1px solid var(--border)", fontSize: "0.8rem",
                                            }}>
                                                <span className="mono" style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                                                    {dv.nullifierHash.slice(0, 10)}...{dv.nullifierHash.slice(-6)}
                                                </span>
                                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                                    {dv.commitmentValid ? (
                                                        <>
                                                            <span style={{
                                                                fontWeight: 700, fontSize: "0.75rem",
                                                                color: dv.vote === 1n ? "var(--success)" : "var(--error)",
                                                            }}>
                                                                {dv.vote === 1n ? "YES" : "NO"}
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

                            {/* Re-tally button */}
                            <button
                                className="btn-secondary"
                                onClick={() => { setTallyResult(null); setTallyStep("idle") }}
                                style={{ marginBottom: 16 }}
                            >
                                Re-tally
                            </button>
                        </>
                    )}
                </>
            )}

            {/* ═══ ADMIN TAB ═══ */}
            {tab === "admin" && (
                <>
                    {!address && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 10 }}>Connect the admin wallet</p>
                            <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 180 }}>Connect</button>
                        </div>
                    )}

                    {address && !isAdmin && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--warning)" }}>
                            <p style={{ color: "var(--warning)", fontSize: "0.85rem" }}>Connected wallet is not the admin.</p>
                        </div>
                    )}

                    {isAdmin && (
                        <>
                            <div className="card" style={{ marginBottom: 16 }}>
                                <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 10 }}>Register Voter</h4>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <input placeholder="Identity commitment" value={commitment} onChange={e => setCommitment(e.target.value)} disabled={adminLoading} style={{ flex: 1 }} />
                                    <button className="btn-primary" onClick={registerVoter} disabled={adminLoading || !commitment.trim() || !state.votingOpen} style={{ width: "auto", padding: "12px 18px" }}>
                                        {adminLoading ? "..." : "Register"}
                                    </button>
                                </div>
                            </div>

                            <div className="card" style={{ marginBottom: 16 }}>
                                <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 10 }}>Bulk Register</h4>
                                <textarea placeholder={"One commitment per line..."} value={bulkCommitments} onChange={e => setBulkCommitments(e.target.value)} disabled={adminLoading} rows={3}
                                    style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", padding: "10px 14px", fontFamily: "inherit", fontSize: "0.85rem", resize: "vertical", outline: "none", marginBottom: 8 }} />
                                <button className="btn-primary" onClick={registerBulk} disabled={adminLoading || !bulkCommitments.trim() || !state.votingOpen}>
                                    {adminLoading ? "Processing..." : "Register All"}
                                </button>
                            </div>

                            {state.votingOpen && (
                                <div className="card" style={{ borderColor: "var(--error)" }}>
                                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8, color: "var(--error)" }}>Close Voting</h4>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>Irreversible. No more votes after this.</p>
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
                </>
            )}
        </>
    )
}
