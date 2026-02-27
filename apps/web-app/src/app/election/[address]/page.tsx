"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback } from "react"
import { Contract, JsonRpcProvider } from "ethers"
import { Group } from "@semaphore-protocol/core"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { generateProofInBrowser } from "@/lib/proof"
import { eciesEncrypt, encodeVotePayload, compressPublicKey } from "@/lib/ecies"
import { CONTRACTS, SPECTRE_VOTING_ABI, SEMAPHORE_ABI, SEPOLIA_RPC } from "@/lib/contracts"
import Link from "next/link"

type Tab = "vote" | "admin"
type VoteStep = "idle" | "fetching-group" | "generating-proof" | "encrypting" | "submitting" | "done" | "error"

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

            const [singles, bulks] = await Promise.all([
                sem.queryFilter(sem.filters.MemberAdded(gid)),
                sem.queryFilter(sem.filters.MembersAdded(gid)),
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
