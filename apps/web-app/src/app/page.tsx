"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback } from "react"
import { Contract, JsonRpcProvider, toUtf8Bytes, toUtf8String, isAddress } from "ethers"
import { secp256k1 } from "@noble/curves/secp256k1"
import Link from "next/link"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, SEPOLIA_RPC } from "@/lib/contracts"
import { friendlyError } from "@/lib/errors"
import { generateCodes, hashCodes, codesToCsv, downloadCsv, storeAdminCodes, hashIdentifiers, storeAdminAllowlist, allowlistToCsv } from "@/lib/inviteCodes"

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
        address, signer, connectWallet, addLog,
    } = useSpectre()

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
    const [gateType, setGateType] = useState<"open" | "invite-codes" | "allowlist" | "admin-only">("open")
    const [codeCount, setCodeCount] = useState("20")
    const [generatedCodes, setGeneratedCodes] = useState<string[]>([])
    const [showCodesModal, setShowCodesModal] = useState(false)
    const [allowlistInput, setAllowlistInput] = useState("")
    const [allowlistIdentifiers, setAllowlistIdentifiers] = useState<string[]>([])
    const [showAllowlistModal, setShowAllowlistModal] = useState(false)
    const [gaslessMode, setGaslessMode] = useState(false)

    // Derive selfSignup from gateType
    const selfSignup = gateType !== "admin-only"

    // Threshold encryption state
    const [encryptionMode, setEncryptionMode] = useState<"single" | "threshold">("single")
    const [committeMembers, setCommitteMembers] = useState<Array<{ name: string; address: string }>>([
        { name: "", address: "" },
        { name: "", address: "" },
        { name: "", address: "" },
    ])
    const [threshold, setThreshold] = useState(2)

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(""), 2000)
    }

    // Committee management
    const addCommitteeMember = () => {
        if (committeMembers.length < 10) {
            setCommitteMembers([...committeMembers, { name: "", address: "" }])
        }
    }
    const removeCommitteeMember = (idx: number) => {
        if (committeMembers.length > 2) {
            const next = committeMembers.filter((_, i) => i !== idx)
            setCommitteMembers(next)
            if (threshold > next.length) setThreshold(next.length)
        }
    }
    const updateCommitteeMember = (idx: number, field: "name" | "address", val: string) => {
        const next = [...committeMembers]
        next[idx] = { ...next[idx], [field]: val }
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

            // Batch-fetch metadata from ElectionDeployed events
            const metaByAddr = new Map<string, string>()
            try {
                const currentBlock = await provider.getBlockNumber()
                const fromBlock = Math.max(0, currentBlock - 49000)
                const deployEvents = await factory.queryFilter(factory.filters.ElectionDeployed(), fromBlock)
                for (const evt of deployEvents) {
                    const args = (evt as any).args
                    try {
                        if (args.metadata && args.metadata !== "0x" && args.metadata.length > 2) {
                            const decoded = toUtf8String(args.metadata)
                            const obj = JSON.parse(decoded)
                            if (obj.title) metaByAddr.set(args.election.toLowerCase(), obj.title)
                        }
                    } catch { /* skip invalid metadata */ }
                }
            } catch { /* fall back to localStorage */ }

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

                    // Priority: on-chain event > localStorage > fallback
                    let title = metaByAddr.get(addr.toLowerCase()) || ""
                    if (!title) {
                        try {
                            const meta = JSON.parse(localStorage.getItem(`spectre-election-meta-${addr}`) || "{}")
                            if (meta.title) title = meta.title
                        } catch { /* ignore */ }
                    }
                    if (!title) title = "Untitled Election"

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

            const validMembers = encryptionMode === "threshold"
                ? committeMembers.filter(m => m.name.trim() && isAddress(m.address.trim()))
                : []

            if (encryptionMode === "threshold") {
                // ── THRESHOLD MODE: pubkey set to (0,0), committee configured after creation ──
                if (validMembers.length < 2) throw new Error("Need at least 2 committee members with valid addresses")
                if (threshold < 2 || threshold > validMembers.length) throw new Error("Invalid threshold")
                pkX = "0"
                pkY = "0"
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

            // Build metadata JSON for on-chain storage
            const metaObj: Record<string, any> = { title: electionTitle.trim(), labels }
            if (gaslessMode || gateType === "invite-codes" || gateType === "allowlist") metaObj.gaslessEnabled = true
            // Invite code gate: generate codes, hash them, add to metadata
            let inviteCodes: string[] = []
            if (gateType === "invite-codes") {
                const count = Math.max(2, Math.min(250, Number(codeCount) || 20))
                inviteCodes = generateCodes(count)
                const codeHashes = hashCodes(inviteCodes)
                metaObj.gateType = "invite-codes"
                metaObj.inviteCodes = { totalCodes: count, codeHashes }
            }
            // Allowlist gate: parse identifiers, hash them, add to metadata
            let parsedAllowlist: string[] = []
            if (gateType === "allowlist") {
                parsedAllowlist = [...new Set(allowlistInput.split("\n").map(s => s.trim()).filter(Boolean))]
                if (parsedAllowlist.length < 2) throw new Error("Need at least 2 allowlist entries")
                const allowlistHashes = hashIdentifiers(parsedAllowlist)
                metaObj.gateType = "allowlist"
                metaObj.allowlist = { totalEntries: parsedAllowlist.length, identifierHashes: allowlistHashes }
            }
            if (encryptionMode === "threshold") {
                metaObj.mode = "threshold"
                metaObj.threshold = threshold
                metaObj.totalShares = validMembers.length
                metaObj.committee = validMembers.map(m => ({ name: m.name.trim(), address: m.address.trim() }))
            }
            const metadataBytes = toUtf8Bytes(JSON.stringify(metaObj))

            addLog("Creating election via factory...")
            const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, signer)
            const tx = await factory.createElection(proposalId, pkX, pkY, signupDeadline, votingDeadline, numOptions, selfSignup, metadataBytes)
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

            // Cache metadata in localStorage
            localStorage.setItem(`spectre-election-meta-${electionAddr}`, JSON.stringify(metaObj))

            // Store invite codes in localStorage + show modal
            if (gateType === "invite-codes" && inviteCodes.length > 0) {
                storeAdminCodes(electionAddr, inviteCodes)
                setGeneratedCodes(inviteCodes)
            }
            // Store allowlist identifiers in localStorage + show modal
            if (gateType === "allowlist" && parsedAllowlist.length > 0) {
                storeAdminAllowlist(electionAddr, parsedAllowlist)
                setAllowlistIdentifiers(parsedAllowlist)
            }

            if (encryptionMode === "threshold") {
                addLog(`Election created. Setting up ${threshold}-of-${validMembers.length} committee...`)

                // Second transaction: call setupCommittee on the election contract
                const election = new Contract(electionAddr, SPECTRE_VOTING_ABI, signer)
                const memberAddresses = validMembers.map(m => m.address.trim())
                const tx2 = await election.setupCommittee(threshold, memberAddresses)
                addLog(`Committee tx sent: ${tx2.hash.slice(0, 16)}...`)
                await tx2.wait()

                addLog(`Committee configured! Members must register keys on the election page.`)
            } else {
                // Store single-key election private key
                if (privKeyHex) {
                    localStorage.setItem(`spectre-election-key-${electionAddr}`, privKeyHex)
                }
                addLog(`Election created: "${electionTitle.trim()}" (${numOptions} options)`)
            }

            // Copy share link
            const shareUrl = `${window.location.origin}/election/${electionAddr}`
            navigator.clipboard.writeText(shareUrl)
            addLog("Share link copied to clipboard!")

            setElectionTitle("")
            setOptionLabels(["Yes", "No"])
            setShowCreate(false)
            setCommitteMembers([{ name: "", address: "" }, { name: "", address: "" }, { name: "", address: "" }])
            setEncryptionMode("single")
            setGateType("open")
            setCodeCount("20")
            setAllowlistInput("")
            await loadElections()

            // Show codes/allowlist modal after everything else is done
            if (gateType === "invite-codes" && inviteCodes.length > 0) {
                setShowCodesModal(true)
            }
            if (gateType === "allowlist" && parsedAllowlist.length > 0) {
                setShowAllowlistModal(true)
            }
        } catch (err: any) {
            addLog(`Failed: ${friendlyError(err)}`)
        } finally {
            setCreating(false)
        }
    }, [signer, electionTitle, optionLabels, signupHours, votingHours, selfSignup, gaslessMode, encryptionMode, committeMembers, threshold, addLog, loadElections, gateType, codeCount, allowlistInput])

    return (
        <>
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
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                        {/* Signup gate selector */}
                        <div>
                            <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                                Who can join?
                            </label>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {([
                                    { key: "open" as const, label: "Open", desc: "Anyone with the link can vote" },
                                    { key: "invite-codes" as const, label: "Invite Codes", desc: "One-time codes you distribute" },
                                    { key: "allowlist" as const, label: "Allowlist", desc: "Only people on your list" },
                                    { key: "admin-only" as const, label: "Admin Only", desc: "You register each voter" },
                                ]).map(g => (
                                    <div
                                        key={g.key}
                                        onClick={() => !creating && setGateType(g.key)}
                                        style={{
                                            flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
                                            border: `1px solid ${gateType === g.key ? "var(--accent)" : "var(--border)"}`,
                                            background: gateType === g.key ? "var(--accent-bg)" : "var(--bg)",
                                            minWidth: "calc(50% - 4px)",
                                        }}
                                    >
                                        <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{g.label}</span>
                                        <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>{g.desc}</p>
                                    </div>
                                ))}
                            </div>
                            {gateType === "invite-codes" && (
                                <div style={{ marginTop: 8, padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                        Number of invite codes (2–250)
                                    </label>
                                    <input
                                        type="number"
                                        min={2}
                                        max={250}
                                        value={codeCount}
                                        onChange={e => setCodeCount(e.target.value)}
                                        disabled={creating}
                                        style={{ width: 100, fontSize: "0.85rem" }}
                                    />
                                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 4 }}>
                                        Each code lets one voter sign up. Codes are shown after election creation.
                                    </p>
                                </div>
                            )}
                            {gateType === "allowlist" && (
                                <div style={{ marginTop: 8, padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                        One identifier per line (email, name, ID...)
                                    </label>
                                    <textarea
                                        placeholder={"alice@example.com\nbob@example.com\ncharlie smith"}
                                        value={allowlistInput}
                                        onChange={e => setAllowlistInput(e.target.value)}
                                        disabled={creating}
                                        rows={5}
                                        style={{ width: "100%", background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", padding: "10px 14px", fontFamily: "inherit", fontSize: "0.85rem", resize: "vertical", outline: "none", marginBottom: 4 }}
                                    />
                                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                                        {(() => {
                                            const count = [...new Set(allowlistInput.split("\n").map(s => s.trim()).filter(Boolean))].length
                                            return `${count} identifier${count !== 1 ? "s" : ""}`
                                        })()} — Voters enter their identifier to sign up
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Voter access mode toggle */}
                        <div
                            onClick={() => !creating && setGaslessMode(!gaslessMode)}
                            role="button"
                            style={{
                                display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                                background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)",
                                cursor: creating ? "not-allowed" : "pointer", userSelect: "none",
                            }}
                        >
                            <div style={{
                                width: 36, height: 20, borderRadius: 10,
                                background: gaslessMode ? "var(--success)" : "var(--border)",
                                position: "relative", transition: "background 0.2s", flexShrink: 0,
                            }}>
                                <div style={{
                                    width: 16, height: 16, borderRadius: "50%", background: "white",
                                    position: "absolute", top: 2,
                                    left: gaslessMode ? 18 : 2,
                                    transition: "left 0.2s",
                                }} />
                            </div>
                            <div>
                                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                                    {gaslessMode ? "No wallet needed" : "Wallet required"}
                                </span>
                                <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 2 }}>
                                    {gaslessMode
                                        ? "No wallet needed \u2014 votes are submitted automatically"
                                        : "Voters need a crypto wallet with ETH to submit votes"}
                                </p>
                            </div>
                        </div>

                        {/* Encryption mode */}
                        <div>
                            <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                                Results security
                            </label>
                            <div style={{ display: "flex", gap: 8 }}>
                                <div
                                    onClick={() => !creating && setEncryptionMode("single")}
                                    style={{
                                        flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
                                        border: `1px solid ${encryptionMode === "single" ? "var(--accent)" : "var(--border)"}`,
                                        background: encryptionMode === "single" ? "var(--accent-bg)" : "var(--bg)",
                                    }}
                                >
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Only you</span>
                                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>You control when results are revealed</p>
                                </div>
                                <div
                                    onClick={() => !creating && setEncryptionMode("threshold")}
                                    style={{
                                        flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
                                        border: `1px solid ${encryptionMode === "threshold" ? "var(--accent)" : "var(--border)"}`,
                                        background: encryptionMode === "threshold" ? "var(--accent-bg)" : "var(--bg)",
                                    }}
                                >
                                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Committee</span>
                                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>Multiple members must agree to reveal results</p>
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
                                <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.4 }}>
                                    Each member generates their own key on the election page. No private keys are shared.
                                </p>
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
                                                    type="text" placeholder="Wallet address (0x...)"
                                                    value={m.address} onChange={e => updateCommitteeMember(i, "address", e.target.value)}
                                                    disabled={creating} className="mono"
                                                    style={{ flex: 1, padding: "6px 10px", fontSize: "0.75rem", minWidth: 0 }}
                                                />
                                            </div>
                                            {m.address && !isAddress(m.address.trim()) && (
                                                <p style={{ marginLeft: 22, fontSize: "0.65rem", color: "var(--error)" }}>Invalid Ethereum address</p>
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
                            Signup: {signupHours}h → Voting: {votingHours}h · {gateType === "open" ? "Open" : gateType === "invite-codes" ? `${codeCount} codes` : gateType === "allowlist" ? `${[...new Set(allowlistInput.split("\n").map(s => s.trim()).filter(Boolean))].length} entries` : "Admin-only"} · {gaslessMode || gateType === "invite-codes" || gateType === "allowlist" ? "Gasless" : "Wallet"} · {encryptionMode === "threshold" ? `${threshold}-of-${committeMembers.filter(m => m.name && isAddress(m.address.trim())).length} committee` : "Single key"} · Share link auto-copied
                        </p>
                        <button
                            className="btn-primary"
                            onClick={createElection}
                            disabled={creating || !electionTitle.trim() || (encryptionMode === "threshold" && committeMembers.filter(m => m.name.trim() && isAddress(m.address.trim())).length < 2)}
                            style={{ width: "auto", padding: "12px 20px" }}
                        >
                            {creating ? "Creating..." : "Create"}
                        </button>
                    </div>
                </div>
            )}

            {/* Invite codes modal */}
            {showCodesModal && generatedCodes.length > 0 && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700 }}>Invite Codes ({generatedCodes.length})</h4>
                        <button
                            onClick={() => setShowCodesModal(false)}
                            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "1.1rem", cursor: "pointer", padding: "0 4px" }}
                        >×</button>
                    </div>
                    <div style={{ padding: "8px 12px", background: "var(--error-bg)", borderRadius: "var(--radius)", border: "1px solid var(--error-border)", marginBottom: 12 }}>
                        <p style={{ fontSize: "0.8rem", color: "var(--error)", fontWeight: 600 }}>
                            Save these codes now — they cannot be recovered later
                        </p>
                    </div>
                    <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 12, padding: "8px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                        {generatedCodes.map((code, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < generatedCodes.length - 1 ? "1px solid var(--border)" : "none" }}>
                                <code className="mono" style={{ fontSize: "0.8rem" }}>{code}</code>
                                <button
                                    onClick={() => copyToClipboard(code, `code-${i}`)}
                                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}
                                >{copied === `code-${i}` ? "Copied!" : "Copy"}</button>
                            </div>
                        ))}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            className="btn-primary"
                            onClick={() => {
                                navigator.clipboard.writeText(generatedCodes.join("\n"))
                                setCopied("all-codes")
                                setTimeout(() => setCopied(""), 2000)
                            }}
                            style={{ flex: 1, fontSize: "0.8rem" }}
                        >{copied === "all-codes" ? "Copied!" : "Copy All"}</button>
                        <button
                            className="btn-secondary"
                            onClick={() => {
                                const csv = codesToCsv(generatedCodes, typeof window !== "undefined" ? window.location.origin + "/election/" : undefined)
                                downloadCsv(csv, `invite-codes-${new Date().toISOString().slice(0, 10)}.csv`)
                            }}
                            style={{ flex: 1, fontSize: "0.8rem" }}
                        >Download CSV</button>
                    </div>
                </div>
            )}

            {/* Allowlist modal */}
            {showAllowlistModal && allowlistIdentifiers.length > 0 && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700 }}>Allowlist ({allowlistIdentifiers.length} entries)</h4>
                        <button
                            onClick={() => setShowAllowlistModal(false)}
                            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "1.1rem", cursor: "pointer", padding: "0 4px" }}
                        >×</button>
                    </div>
                    <div style={{ padding: "8px 12px", background: "var(--success-bg)", borderRadius: "var(--radius)", border: "1px solid var(--success-border)", marginBottom: 12 }}>
                        <p style={{ fontSize: "0.8rem", color: "var(--success)", fontWeight: 600 }}>
                            Allowlist saved. Share links with voters or let them enter their identifier manually.
                        </p>
                    </div>
                    <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 12, padding: "8px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                        {allowlistIdentifiers.map((id, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < allowlistIdentifiers.length - 1 ? "1px solid var(--border)" : "none" }}>
                                <span style={{ fontSize: "0.8rem" }}>{id}</span>
                                <button
                                    onClick={() => copyToClipboard(id, `allowlist-${i}`)}
                                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}
                                >{copied === `allowlist-${i}` ? "Copied!" : "Copy"}</button>
                            </div>
                        ))}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            className="btn-primary"
                            onClick={() => {
                                navigator.clipboard.writeText(allowlistIdentifiers.join("\n"))
                                setCopied("all-allowlist")
                                setTimeout(() => setCopied(""), 2000)
                            }}
                            style={{ flex: 1, fontSize: "0.8rem" }}
                        >{copied === "all-allowlist" ? "Copied!" : "Copy All"}</button>
                        <button
                            className="btn-secondary"
                            onClick={() => {
                                const csv = allowlistToCsv(allowlistIdentifiers, typeof window !== "undefined" ? window.location.origin + "/election/" : undefined)
                                downloadCsv(csv, `allowlist-${new Date().toISOString().slice(0, 10)}.csv`)
                            }}
                            style={{ flex: 1, fontSize: "0.8rem" }}
                        >Download CSV</button>
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
                                    <span className={`status-badge ${e.phase === "closed" ? "status-closed" : "status-open"}`}>
                                        {e.phase === "signup" ? "REGISTRATION" : e.phase === "voting" ? "VOTING" : "ENDED"}
                                    </span>
                                </div>
                                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                    <span>{e.voteCount} vote{e.voteCount !== 1 ? "s" : ""}</span>
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </>
    )
}
