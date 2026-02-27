"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback } from "react"
import { Contract, JsonRpcProvider } from "ethers"
import { secp256k1 } from "@noble/curves/secp256k1"
import Link from "next/link"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, SEPOLIA_RPC } from "@/lib/contracts"
import { friendlyError } from "@/lib/errors"
import { setupElection, encryptedShareToHex, generateCommitteeKeypair, isValidPublicKey, type CommitteeMember, type ElectionSetup } from "@/lib/threshold"

interface ElectionInfo {
    address: string
    proposalId: string
    signupOpen: boolean
    votingOpen: boolean
    voteCount: number
    admin: string
    title: string
    phase: "signup" | "voting" | "closed"
}

export default function HomePage() {
    const {
        identity, createIdentity, importIdentity, clearIdentity,
        address, signer, connectWallet, addLog,
    } = useSpectre()

    const [importKey, setImportKey] = useState("")
    const [copied, setCopied] = useState("")
    const [elections, setElections] = useState<ElectionInfo[]>([])
    const [loadingElections, setLoadingElections] = useState(true)

    // Create election form
    const [showCreate, setShowCreate] = useState(false)
    const [electionTitle, setElectionTitle] = useState("")
    const [optionLabels, setOptionLabels] = useState<string[]>(["Yes", "No"])
    const [signupHours, setSignupHours] = useState("24")
    const [votingHours, setVotingHours] = useState("72")
    const [creating, setCreating] = useState(false)
    const [selfSignup, setSelfSignup] = useState(true)

    // Threshold encryption state
    const [encryptionMode, setEncryptionMode] = useState<"single" | "threshold">("single")
    const [committeMembers, setCommitteMembers] = useState<Array<{ name: string; pubkey: string; generatedPrivkey?: string }>>([
        { name: "", pubkey: "" },
        { name: "", pubkey: "" },
        { name: "", pubkey: "" },
    ])
    const [threshold, setThreshold] = useState(2)
    const [showShareDistribution, setShowShareDistribution] = useState(false)
    const [createdElectionSetup, setCreatedElectionSetup] = useState<{
        electionAddr: string
        shares: Array<{ memberId: string; shareIndex: string; encryptedDataHex: string }>
        threshold: number
        totalShares: number
    } | null>(null)

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(""), 2000)
    }

    // Committee management
    const addCommitteeMember = () => {
        if (committeMembers.length < 10) {
            setCommitteMembers([...committeMembers, { name: "", pubkey: "" }])
        }
    }
    const removeCommitteeMember = (idx: number) => {
        if (committeMembers.length > 2) {
            const next = committeMembers.filter((_, i) => i !== idx)
            setCommitteMembers(next)
            if (threshold > next.length) setThreshold(next.length)
        }
    }
    const updateCommitteeMember = (idx: number, field: "name" | "pubkey", val: string) => {
        const next = [...committeMembers]
        next[idx] = { ...next[idx], [field]: val }
        setCommitteMembers(next)
    }
    const generateKeyForMember = (idx: number) => {
        const kp = generateCommitteeKeypair()
        const next = [...committeMembers]
        next[idx] = { ...next[idx], pubkey: kp.publicKeyHex, generatedPrivkey: kp.privateKeyHex }
        setCommitteMembers(next)
    }

    // Manage option labels
    const addOption = () => {
        if (optionLabels.length < 10) {
            setOptionLabels([...optionLabels, ""])
        }
    }
    const removeOption = (idx: number) => {
        if (optionLabels.length > 2) {
            setOptionLabels(optionLabels.filter((_, i) => i !== idx))
        }
    }
    const updateOption = (idx: number, val: string) => {
        const next = [...optionLabels]
        next[idx] = val
        setOptionLabels(next)
    }

    // Fetch all elections from factory
    const loadElections = useCallback(async () => {
        try {
            const provider = new JsonRpcProvider(SEPOLIA_RPC)
            const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
            const count = await factory.electionCount()
            const total = Number(count)

            if (total === 0) {
                setElections([])
                setLoadingElections(false)
                return
            }

            const addresses = await factory.getElections(0, total)
            const infos: ElectionInfo[] = []

            for (const addr of addresses) {
                try {
                    const election = new Contract(addr, SPECTRE_VOTING_ABI, provider)
                    const [pid, sOpen, vOpen, vc, admin] = await Promise.all([
                        election.proposalId(),
                        election.signupOpen(),
                        election.votingOpen(),
                        election.voteCount(),
                        election.admin(),
                    ])

                    let title = `Proposal #${pid.toString()}`
                    try {
                        const meta = JSON.parse(localStorage.getItem(`spectre-election-meta-${addr}`) || "{}")
                        if (meta.title) title = meta.title
                    } catch { /* ignore */ }

                    const phase = sOpen ? "signup" : vOpen ? "voting" : "closed"

                    infos.push({
                        address: addr,
                        proposalId: pid.toString(),
                        signupOpen: sOpen,
                        votingOpen: vOpen,
                        voteCount: Number(vc),
                        admin,
                        title,
                        phase,
                    })
                } catch { /* skip broken elections */ }
            }

            setElections(infos.reverse())
        } catch (err: any) {
            addLog(`Failed to load elections: ${err.message}`)
        } finally {
            setLoadingElections(false)
        }
    }, [addLog])

    useEffect(() => { loadElections() }, [loadElections])

    // Create a new election via factory
    const createElection = useCallback(async () => {
        if (!signer || !electionTitle.trim()) return
        setCreating(true)
        try {
            const proposalId = Math.floor(Date.now() / 1000)
            let pkX: string, pkY: string
            let privKeyHex: string | null = null
            let electionSetupResult: ElectionSetup | null = null

            if (encryptionMode === "threshold") {
                // ── THRESHOLD MODE: dealer ceremony ──
                const validMembers = committeMembers.filter(m => m.name.trim() && m.pubkey.trim())
                if (validMembers.length < 2) throw new Error("Need at least 2 committee members")
                if (threshold < 2 || threshold > validMembers.length) throw new Error("Invalid threshold")

                addLog(`Running dealer ceremony (${threshold}-of-${validMembers.length})...`)
                const committee: CommitteeMember[] = validMembers.map(m => {
                    const pubBuf = new Uint8Array(33)
                    for (let i = 0; i < 33; i++) pubBuf[i] = parseInt(m.pubkey.substring(i * 2, i * 2 + 2), 16)
                    return { id: m.name.trim(), publicKey: pubBuf }
                })

                electionSetupResult = setupElection(committee, threshold)

                // Decompress pubkey from 33 bytes → (x, y)
                const point = secp256k1.ProjectivePoint.fromHex(electionSetupResult.electionPubKey)
                pkX = point.x.toString()
                pkY = point.y.toString()
                addLog("Dealer ceremony complete — master key discarded")
            } else {
                // ── SINGLE KEY MODE (existing flow) ──
                const privKey = secp256k1.utils.randomPrivateKey()
                const pubKey = secp256k1.ProjectivePoint.fromPrivateKey(privKey)
                pkX = pubKey.x.toString()
                pkY = pubKey.y.toString()
                privKeyHex = Buffer.from(privKey).toString("hex")
            }

            // Calculate deadlines
            let signupDeadline = 0n
            if (signupHours && Number(signupHours) > 0) {
                signupDeadline = BigInt(Math.floor(Date.now() / 1000) + Number(signupHours) * 3600)
            }
            let votingDeadline = 0n
            if (votingHours && Number(votingHours) > 0) {
                votingDeadline = BigInt(Math.floor(Date.now() / 1000) + Number(signupHours) * 3600 + Number(votingHours) * 3600)
            }

            const numOptions = optionLabels.length
            const labels = optionLabels.map((l, i) => l.trim() || `Option ${i}`)

            addLog("Creating election via factory...")
            const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, signer)
            const tx = await factory.createElection(proposalId, pkX, pkY, signupDeadline, votingDeadline, numOptions, selfSignup)
            addLog(`Tx sent: ${tx.hash.slice(0, 16)}...`)

            const receipt = await tx.wait()

            // Parse ElectionDeployed event to get the new address
            const iface = factory.interface
            let electionAddr = ""
            for (const log of receipt.logs) {
                try {
                    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
                    if (parsed?.name === "ElectionDeployed") {
                        electionAddr = parsed.args.election
                    }
                } catch { /* skip */ }
            }

            if (encryptionMode === "threshold" && electionSetupResult) {
                // Store threshold metadata (no private key!)
                const meta = {
                    title: electionTitle.trim(),
                    labels,
                    mode: "threshold" as const,
                    threshold: electionSetupResult.threshold,
                    totalShares: electionSetupResult.totalShares,
                    committee: committeMembers
                        .filter(m => m.name.trim() && m.pubkey.trim())
                        .map(m => ({ id: m.name.trim(), publicKeyHex: m.pubkey })),
                    encryptedShares: electionSetupResult.encryptedShares.map(s => ({
                        memberId: s.memberId,
                        shareIndex: s.shareIndex.toString(),
                        encryptedDataHex: encryptedShareToHex(s.encryptedData),
                    })),
                }
                localStorage.setItem(`spectre-election-meta-${electionAddr}`, JSON.stringify(meta))
                addLog(`Threshold election created: "${meta.title}" (${threshold}-of-${meta.committee.length})`)

                // Show share distribution UI
                setCreatedElectionSetup({
                    electionAddr,
                    shares: meta.encryptedShares,
                    threshold: meta.threshold,
                    totalShares: meta.totalShares,
                })
                setShowShareDistribution(true)
            } else {
                // Store single-key election data
                if (privKeyHex) {
                    localStorage.setItem(`spectre-election-key-${electionAddr}`, privKeyHex)
                }
                const meta = { title: electionTitle.trim(), labels }
                localStorage.setItem(`spectre-election-meta-${electionAddr}`, JSON.stringify(meta))
                addLog(`Election created: "${electionTitle.trim()}" (${numOptions} options)`)
            }

            // Copy share link
            const shareUrl = `${window.location.origin}/election/${electionAddr}?t=${encodeURIComponent(electionTitle.trim())}&labels=${encodeURIComponent(labels.join(","))}`
            navigator.clipboard.writeText(shareUrl)
            addLog("Share link copied to clipboard!")

            if (!showShareDistribution) {
                setElectionTitle("")
                setOptionLabels(["Yes", "No"])
                setShowCreate(false)
            }
            await loadElections()
        } catch (err: any) {
            addLog(`Failed: ${friendlyError(err)}`)
        } finally {
            setCreating(false)
        }
    }, [signer, electionTitle, optionLabels, signupHours, votingHours, selfSignup, encryptionMode, committeMembers, threshold, showShareDistribution, addLog, loadElections])

    const [showIdentity, setShowIdentity] = useState(false)

    return (
        <>
            {/* Identity */}
            <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    onClick={() => setShowIdentity(!showIdentity)}
                    role="button"
                >
                    <h3 style={{ fontSize: "0.95rem", fontWeight: 700 }}>
                        {identity ? "Identity Active" : "Set Up Identity"}
                    </h3>
                    {identity ? (
                        <span style={{ fontSize: "0.7rem", color: "var(--success)", background: "#22c55e18", padding: "4px 10px", borderRadius: 20, cursor: "pointer" }}>
                            {showIdentity ? "Hide" : "Show"}
                        </span>
                    ) : (
                        <span style={{ fontSize: "0.7rem", color: "var(--warning)", background: "#f59e0b18", padding: "4px 10px", borderRadius: 20, cursor: "pointer" }}>
                            Required to vote
                        </span>
                    )}
                </div>

                {(showIdentity || !identity) && (
                    <div style={{ marginTop: 12 }}>
                        {!address ? (
                            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                                Connect your wallet first — each wallet gets its own identity.
                            </p>
                        ) : identity ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                <div>
                                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                        Your Voter ID
                                    </label>
                                    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                                        <code className="mono" style={{ flex: 1, background: "var(--bg)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.7rem" }}>
                                            {identity.commitment.toString()}
                                        </code>
                                        <button onClick={() => copyToClipboard(identity.commitment.toString(), "c")} className="btn-secondary" style={{ width: "auto", padding: "8px 12px", fontSize: "0.7rem" }}>
                                            {copied === "c" ? "Copied!" : "Copy"}
                                        </button>
                                    </div>
                                </div>
                                <details style={{ fontSize: "0.8rem" }}>
                                    <summary style={{ color: "var(--text-muted)", cursor: "pointer" }}>Advanced: backup key</summary>
                                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                        <code className="mono" style={{ flex: 1, background: "var(--bg)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.7rem" }}>
                                            {identity.export()}
                                        </code>
                                        <button onClick={() => copyToClipboard(identity.export(), "pk")} className="btn-secondary" style={{ width: "auto", padding: "8px 12px", fontSize: "0.7rem" }}>
                                            {copied === "pk" ? "Copied!" : "Copy"}
                                        </button>
                                    </div>
                                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                        <button className="btn-secondary" onClick={createIdentity} style={{ flex: 1, fontSize: "0.8rem" }}>Regenerate</button>
                                        <button className="btn-secondary" onClick={clearIdentity} style={{ flex: 1, fontSize: "0.8rem" }}>Clear</button>
                                    </div>
                                </details>
                            </div>
                        ) : (
                            <div>
                                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 12 }}>
                                    Create an anonymous identity for this wallet. Each wallet gets its own identity.
                                </p>
                                <button className="btn-primary" onClick={createIdentity} style={{ marginBottom: 12 }}>
                                    Create Identity
                                </button>
                                <details style={{ fontSize: "0.8rem" }}>
                                    <summary style={{ color: "var(--text-muted)", cursor: "pointer" }}>Import existing identity</summary>
                                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                        <input placeholder="Paste base64 private key..." value={importKey} onChange={e => setImportKey(e.target.value)} style={{ flex: 1, fontSize: "0.8rem" }} />
                                        <button className="btn-secondary" onClick={() => { importIdentity(importKey); setImportKey("") }} disabled={!importKey} style={{ width: "auto", padding: "10px 14px", fontSize: "0.8rem" }}>Import</button>
                                    </div>
                                </details>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Elections header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>Elections</h3>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-secondary" onClick={loadElections} style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}>
                        Refresh
                    </button>
                    {address && (
                        <button className="btn-primary" onClick={() => setShowCreate(!showCreate)} style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}>
                            + New
                        </button>
                    )}
                </div>
            </div>

            {/* Create election form */}
            {showCreate && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                    <h4 style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: 12 }}>Create Election</h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                        <input
                            type="text"
                            placeholder="What are you voting on? (e.g. &quot;Approve Q1 Budget&quot;)"
                            value={electionTitle}
                            onChange={e => setElectionTitle(e.target.value)}
                            disabled={creating}
                        />

                        {/* Vote options */}
                        <div>
                            <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                                Vote Options ({optionLabels.length})
                            </label>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {optionLabels.map((label, i) => (
                                    <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", width: 20, textAlign: "center" }}>{i}</span>
                                        <input
                                            type="text"
                                            placeholder={`Option ${i} label`}
                                            value={label}
                                            onChange={e => updateOption(i, e.target.value)}
                                            disabled={creating}
                                            style={{ flex: 1 }}
                                        />
                                        {optionLabels.length > 2 && (
                                            <button
                                                onClick={() => removeOption(i)}
                                                disabled={creating}
                                                style={{ background: "none", border: "none", color: "var(--error)", fontSize: "1rem", cursor: "pointer", padding: "0 6px" }}
                                            >
                                                ×
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            {optionLabels.length < 10 && (
                                <button
                                    onClick={addOption}
                                    disabled={creating}
                                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.8rem", cursor: "pointer", padding: "6px 0", marginTop: 4 }}
                                >
                                    + Add option
                                </button>
                            )}
                        </div>

                        {/* Deadlines */}
                        <div style={{ display: "flex", gap: 8 }}>
                            <div style={{ flex: 1 }}>
                                <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                    Signup duration (hours)
                                </label>
                                <input
                                    type="number"
                                    placeholder="24"
                                    value={signupHours}
                                    onChange={e => setSignupHours(e.target.value)}
                                    disabled={creating}
                                />
                            </div>
                            <div style={{ flex: 1 }}>
                                <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                    Voting duration (hours)
                                </label>
                                <input
                                    type="number"
                                    placeholder="72"
                                    value={votingHours}
                                    onChange={e => setVotingHours(e.target.value)}
                                    disabled={creating}
                                />
                            </div>
                        </div>
                        {/* Signup mode toggle */}
                        <div
                            onClick={() => !creating && setSelfSignup(!selfSignup)}
                            role="button"
                            style={{
                                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                                background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)",
                                cursor: creating ? "not-allowed" : "pointer", userSelect: "none",
                            }}
                        >
                            <div style={{
                                width: 36, height: 20, borderRadius: 10,
                                background: selfSignup ? "var(--accent)" : "var(--border)",
                                position: "relative", transition: "background 0.2s", flexShrink: 0,
                            }}>
                                <div style={{
                                    width: 16, height: 16, borderRadius: "50%", background: "white",
                                    position: "absolute", top: 2,
                                    left: selfSignup ? 18 : 2,
                                    transition: "left 0.2s",
                                }} />
                            </div>
                            <div>
                                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                                    {selfSignup ? "Open signup" : "Gated (admin-only)"}
                                </span>
                                <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 2 }}>
                                    {selfSignup
                                        ? "Anyone with the link can self-register to vote"
                                        : "Only you (admin) can register voters"}
                                </p>
                            </div>
                        </div>

                        {/* Encryption mode */}
                        <div>
                            <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                                Encryption Mode
                            </label>
                            <div style={{ display: "flex", gap: 8 }}>
                                <div
                                    onClick={() => !creating && setEncryptionMode("single")}
                                    style={{
                                        flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
                                        border: `1px solid ${encryptionMode === "single" ? "var(--accent)" : "var(--border)"}`,
                                        background: encryptionMode === "single" ? "#6366f115" : "var(--bg)",
                                    }}
                                >
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Single Key</span>
                                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>You hold the decryption key</p>
                                </div>
                                <div
                                    onClick={() => !creating && setEncryptionMode("threshold")}
                                    style={{
                                        flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
                                        border: `1px solid ${encryptionMode === "threshold" ? "var(--accent)" : "var(--border)"}`,
                                        background: encryptionMode === "threshold" ? "#6366f115" : "var(--bg)",
                                    }}
                                >
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Threshold</span>
                                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>t-of-n committee decrypts</p>
                                </div>
                            </div>
                        </div>

                        {/* Committee setup (threshold mode) */}
                        {encryptionMode === "threshold" && (
                            <div style={{ padding: "12px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                        Committee ({committeMembers.length} members)
                                    </label>
                                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                        <label style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Threshold:</label>
                                        <select
                                            value={threshold}
                                            onChange={e => setThreshold(Number(e.target.value))}
                                            disabled={creating}
                                            style={{ padding: "4px 8px", fontSize: "0.8rem", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
                                        >
                                            {Array.from({ length: committeMembers.length - 1 }, (_, i) => i + 2).map(t => (
                                                <option key={t} value={t}>{t} of {committeMembers.length}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    {committeMembers.map((m, i) => (
                                        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", background: "var(--card)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", width: 16 }}>{i + 1}</span>
                                                <input
                                                    type="text" placeholder="Name"
                                                    value={m.name} onChange={e => updateCommitteeMember(i, "name", e.target.value)}
                                                    disabled={creating} style={{ flex: 1, padding: "6px 10px", fontSize: "0.8rem" }}
                                                />
                                                {committeMembers.length > 2 && (
                                                    <button onClick={() => removeCommitteeMember(i)} disabled={creating}
                                                        style={{ background: "none", border: "none", color: "var(--error)", fontSize: "1rem", cursor: "pointer", padding: "0 4px" }}>×</button>
                                                )}
                                            </div>
                                            <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 22 }}>
                                                <input
                                                    type="text" placeholder="Public key (66 hex chars)"
                                                    value={m.pubkey} onChange={e => updateCommitteeMember(i, "pubkey", e.target.value)}
                                                    disabled={creating} className="mono"
                                                    style={{ flex: 1, padding: "6px 10px", fontSize: "0.65rem" }}
                                                />
                                                <button onClick={() => generateKeyForMember(i)} disabled={creating}
                                                    className="btn-secondary" style={{ width: "auto", padding: "6px 10px", fontSize: "0.65rem", whiteSpace: "nowrap" }}>
                                                    Generate
                                                </button>
                                            </div>
                                            {m.generatedPrivkey && (
                                                <div style={{ marginLeft: 22, padding: "6px 10px", background: "#f59e0b10", borderRadius: 6, border: "1px solid #f59e0b30" }}>
                                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                                        <span style={{ fontSize: "0.6rem", color: "var(--warning)" }}>Private key (send securely to member!):</span>
                                                        <button onClick={() => copyToClipboard(m.generatedPrivkey!, `pk-${i}`)}
                                                            style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.65rem", cursor: "pointer" }}>
                                                            {copied === `pk-${i}` ? "Copied!" : "Copy"}
                                                        </button>
                                                    </div>
                                                    <code className="mono" style={{ fontSize: "0.55rem", color: "var(--text-muted)", wordBreak: "break-all", display: "block", marginTop: 2 }}>
                                                        {m.generatedPrivkey}
                                                    </code>
                                                </div>
                                            )}
                                            {m.pubkey && !isValidPublicKey(m.pubkey) && (
                                                <p style={{ marginLeft: 22, fontSize: "0.65rem", color: "var(--error)" }}>Invalid public key</p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                {committeMembers.length < 10 && (
                                    <button onClick={addCommitteeMember} disabled={creating}
                                        style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.75rem", cursor: "pointer", padding: "6px 0", marginTop: 4 }}>
                                        + Add member
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", flex: 1 }}>
                            Signup: {signupHours}h → Voting: {votingHours}h · {selfSignup ? "Open" : "Gated"} · {encryptionMode === "threshold" ? `${threshold}-of-${committeMembers.filter(m => m.name && m.pubkey).length} threshold` : "Single key"} · Share link auto-copied
                        </p>
                        <button
                            className="btn-primary"
                            onClick={createElection}
                            disabled={creating || !electionTitle.trim() || (encryptionMode === "threshold" && committeMembers.filter(m => m.name.trim() && isValidPublicKey(m.pubkey)).length < 2)}
                            style={{ width: "auto", padding: "12px 20px" }}
                        >
                            {creating ? "Deploying..." : "Create"}
                        </button>
                    </div>
                </div>
            )}

            {/* Share Distribution Modal (after threshold election creation) */}
            {showShareDistribution && createdElectionSetup && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8, color: "var(--success)" }}>Threshold Election Created!</h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                        {createdElectionSetup.threshold} of {createdElectionSetup.totalShares} committee members must cooperate to decrypt results.
                        Distribute each member&apos;s encrypted share to them privately.
                    </p>

                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                        {createdElectionSetup.shares.map((s, i) => (
                            <div key={i} style={{ padding: "10px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{s.memberId}</span>
                                    <button onClick={() => copyToClipboard(s.encryptedDataHex, `share-${i}`)}
                                        className="btn-secondary" style={{ width: "auto", padding: "4px 10px", fontSize: "0.65rem" }}>
                                        {copied === `share-${i}` ? "Copied!" : "Copy Share"}
                                    </button>
                                </div>
                                <code className="mono" style={{ fontSize: "0.5rem", color: "var(--text-muted)", wordBreak: "break-all", display: "block" }}>
                                    {s.encryptedDataHex.slice(0, 64)}...
                                </code>
                            </div>
                        ))}
                    </div>

                    <button onClick={() => {
                        copyToClipboard(JSON.stringify(createdElectionSetup.shares, null, 2), "all-shares")
                    }} className="btn-secondary" style={{ marginBottom: 8 }}>
                        {copied === "all-shares" ? "Copied!" : "Copy All Shares (JSON)"}
                    </button>

                    <button onClick={() => {
                        setShowShareDistribution(false)
                        setCreatedElectionSetup(null)
                        setElectionTitle("")
                        setOptionLabels(["Yes", "No"])
                        setEncryptionMode("single")
                        setCommitteMembers([{ name: "", pubkey: "" }, { name: "", pubkey: "" }, { name: "", pubkey: "" }])
                        setShowCreate(false)
                    }} className="btn-primary">
                        Done
                    </button>
                </div>
            )}

            {!address && (
                <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 12 }}>
                        Connect your wallet to create elections or vote
                    </p>
                    <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 200 }}>
                        Connect Wallet
                    </button>
                </div>
            )}

            {/* Election list */}
            {loadingElections ? (
                <div className="card" style={{ textAlign: "center", padding: 32 }}>
                    <div className="spinner" style={{ margin: "0 auto 12px" }} />
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading elections...</p>
                </div>
            ) : elections.length === 0 ? (
                <div className="card" style={{ textAlign: "center", padding: 32 }}>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
                        No elections yet. Create the first one!
                    </p>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {elections.map(e => (
                        <Link
                            key={e.address}
                            href={`/election/${e.address}`}
                            style={{ textDecoration: "none", color: "inherit" }}
                        >
                            <div className="card" style={{ cursor: "pointer", transition: "border-color 0.15s" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                                    <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                                        {e.title}
                                    </span>
                                    <span className={`status-badge ${e.phase === "closed" ? "status-closed" : "status-open"}`}>
                                        {e.phase === "signup" ? "SIGNUP" : e.phase === "voting" ? "VOTING" : "CLOSED"}
                                    </span>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                    <span>{e.voteCount} vote{e.voteCount !== 1 ? "s" : ""}</span>
                                    <span className="mono" style={{ fontSize: "0.7rem" }}>
                                        {e.address.slice(0, 8)}...{e.address.slice(-6)}
                                    </span>
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </>
    )
}
