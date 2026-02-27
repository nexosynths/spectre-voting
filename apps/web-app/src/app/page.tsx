"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback } from "react"
import { Contract, JsonRpcProvider } from "ethers"
import { secp256k1 } from "@noble/curves/secp256k1"
import Link from "next/link"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, SEPOLIA_RPC } from "@/lib/contracts"

interface ElectionInfo {
    address: string
    proposalId: string
    votingOpen: boolean
    voteCount: number
    admin: string
    title: string // from localStorage metadata
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
    const [yesLabel, setYesLabel] = useState("")
    const [noLabel, setNoLabel] = useState("")
    const [deadlineHours, setDeadlineHours] = useState("24")
    const [creating, setCreating] = useState(false)

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(""), 2000)
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
                    const [pid, open, vc, admin] = await Promise.all([
                        election.proposalId(),
                        election.votingOpen(),
                        election.voteCount(),
                        election.admin(),
                    ])

                    // Read title from localStorage metadata
                    let title = `Proposal #${pid.toString()}`
                    try {
                        const meta = JSON.parse(localStorage.getItem(`spectre-election-meta-${addr}`) || "{}")
                        if (meta.title) title = meta.title
                    } catch { /* ignore */ }

                    infos.push({
                        address: addr,
                        proposalId: pid.toString(),
                        votingOpen: open,
                        voteCount: Number(vc),
                        admin: admin,
                        title,
                    })
                } catch { /* skip broken elections */ }
            }

            setElections(infos.reverse()) // newest first
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
            // Auto-generate a unique proposalId from timestamp
            const proposalId = Math.floor(Date.now() / 1000)

            // Generate election keypair
            const privKey = secp256k1.utils.randomPrivateKey()
            const pubKey = secp256k1.ProjectivePoint.fromPrivateKey(privKey)
            const pkX = pubKey.x.toString()
            const pkY = pubKey.y.toString()

            // Calculate voting deadline (0 = no deadline)
            let deadline = 0n
            if (deadlineHours && Number(deadlineHours) > 0) {
                deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineHours) * 3600)
            }

            addLog("Creating election via factory...")
            const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, signer)
            const tx = await factory.createElection(proposalId, pkX, pkY, deadline)
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
                } catch { /* skip non-matching logs */ }
            }

            // Store election private key
            const privKeyHex = Buffer.from(privKey).toString("hex")
            localStorage.setItem(`spectre-election-key-${electionAddr}`, privKeyHex)

            // Store election metadata (title + custom labels)
            const meta = {
                title: electionTitle.trim(),
                yesLabel: yesLabel.trim() || "Yes",
                noLabel: noLabel.trim() || "No",
            }
            localStorage.setItem(`spectre-election-meta-${electionAddr}`, JSON.stringify(meta))

            addLog(`Election created: "${meta.title}"`)

            // Copy share link to clipboard
            const shareUrl = `${window.location.origin}/election/${electionAddr}?t=${encodeURIComponent(meta.title)}&y=${encodeURIComponent(meta.yesLabel)}&n=${encodeURIComponent(meta.noLabel)}`
            navigator.clipboard.writeText(shareUrl)
            addLog(`Share link copied to clipboard!`)

            setElectionTitle("")
            setYesLabel("")
            setNoLabel("")
            setShowCreate(false)
            await loadElections()
        } catch (err: any) {
            addLog(`Failed: ${err.reason || err.message}`)
        } finally {
            setCreating(false)
        }
    }, [signer, electionTitle, yesLabel, noLabel, deadlineHours, addLog, loadElections])

    // Show/hide identity section
    const [showIdentity, setShowIdentity] = useState(false)

    return (
        <>
            {/* Identity — collapsed if already generated */}
            <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    onClick={() => setShowIdentity(!showIdentity)}
                    role="button"
                >
                    <h3 style={{ fontSize: "0.95rem", fontWeight: 700 }}>
                        {identity ? "🔑 Identity Active" : "🔑 Set Up Identity"}
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
                        {identity ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                <div>
                                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                        Your Voter ID (share this with the election admin to get registered)
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
                                    Create an anonymous identity to vote in elections. Your identity stays in this browser — nobody can link it to you.
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

            {/* Elections */}
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
                        <div style={{ display: "flex", gap: 8 }}>
                            <input
                                type="text"
                                placeholder="Yes label (default: Yes)"
                                value={yesLabel}
                                onChange={e => setYesLabel(e.target.value)}
                                disabled={creating}
                                style={{ flex: 1 }}
                            />
                            <input
                                type="text"
                                placeholder="No label (default: No)"
                                value={noLabel}
                                onChange={e => setNoLabel(e.target.value)}
                                disabled={creating}
                                style={{ flex: 1 }}
                            />
                        </div>
                        <input
                            type="number"
                            placeholder="Duration in hours (default: 24)"
                            value={deadlineHours}
                            onChange={e => setDeadlineHours(e.target.value)}
                            disabled={creating}
                        />
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", flex: 1 }}>
                            {deadlineHours && Number(deadlineHours) > 0
                                ? `Closes in ${deadlineHours}h · Share link auto-copied after deploy`
                                : "No deadline · Share link auto-copied after deploy"}
                        </p>
                        <button
                            className="btn-primary"
                            onClick={createElection}
                            disabled={creating || !electionTitle.trim()}
                            style={{ width: "auto", padding: "12px 20px" }}
                        >
                            {creating ? "Deploying..." : "Create"}
                        </button>
                    </div>
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
                                    <span className={`status-badge ${e.votingOpen ? "status-open" : "status-closed"}`}>
                                        {e.votingOpen ? "OPEN" : "CLOSED"}
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
