"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useMode } from "@/context/ModeContext"
import { useState, useEffect, useCallback } from "react"
import { Contract, JsonRpcProvider, toUtf8Bytes, toUtf8String, isAddress } from "ethers"
import { secp256k1 } from "@noble/curves/secp256k1"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, RPC_URL, MAX_LOG_RANGE, FACTORY_DEPLOY_BLOCK } from "@/lib/contracts"
import { friendlyError } from "@/lib/errors"
import { generateCodes, hashCodes, codesToCsv, downloadCsv, storeAdminCodes, hashIdentifiers, storeAdminAllowlist, allowlistToCsv } from "@/lib/inviteCodes"
import CreateSimpleForm from "@/components/CreateSimpleForm"
import GateSelector from "@/components/GateSelector"
import ContextualWarnings from "@/components/ContextualWarning"
import TrustCallout from "@/components/TrustCallout"
import CodesModal from "@/components/CodesModal"
import AllowlistModal from "@/components/AllowlistModal"
import ElectionList from "@/components/ElectionList"
import TrustSummary from "@/components/TrustSummary"

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
    const { isSimple } = useMode()

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
    const [gateType, setGateType] = useState<"open" | "invite-codes" | "allowlist" | "admin-only" | "token-gate" | "email-domain" | "github-org">("open")
    const [codeCount, setCodeCount] = useState("20")
    const [generatedCodes, setGeneratedCodes] = useState<string[]>([])
    const [showCodesModal, setShowCodesModal] = useState(false)
    const [allowlistInput, setAllowlistInput] = useState("")
    const [allowlistIdentifiers, setAllowlistIdentifiers] = useState<string[]>([])
    const [showAllowlistModal, setShowAllowlistModal] = useState(false)
    const [tokenAddress, setTokenAddress] = useState("")
    const [tokenType, setTokenType] = useState<"erc20" | "erc721">("erc20")
    const [tokenMinBalance, setTokenMinBalance] = useState("1")
    const [tokenSymbol, setTokenSymbol] = useState("")
    const [tokenDecimals, setTokenDecimals] = useState(18)
    const [emailDomains, setEmailDomains] = useState("")
    const [githubOrg, setGithubOrg] = useState("")
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

    // Auto-fetch token symbol/decimals when token address changes
    useEffect(() => {
        if (gateType !== "token-gate" || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
            setTokenSymbol("")
            return
        }
        let cancelled = false
        ;(async () => {
            try {
                const provider = new JsonRpcProvider(RPC_URL)
                const erc20Abi = ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function name() view returns (string)"]
                const c = new Contract(tokenAddress, erc20Abi, provider)
                const [sym, dec] = await Promise.all([c.symbol().catch(() => ""), c.decimals().catch(() => 0)])
                if (!cancelled) {
                    setTokenSymbol(sym || "")
                    setTokenDecimals(Number(dec) || 0)
                }
            } catch {
                if (!cancelled) { setTokenSymbol(""); setTokenDecimals(0) }
            }
        })()
        return () => { cancelled = true }
    }, [tokenAddress, gateType])

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
            const provider = new JsonRpcProvider(RPC_URL)
            const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
            const count = await factory.electionCount()
            const total = Number(count)

            if (total === 0) {
                setElections([])
                setLoadingElections(false)
                return
            }

            const addresses = await factory.getElections(0, total)

            // Batch-fetch metadata from ElectionDeployed events (paginated for Base 10k block limit)
            const metaByAddr = new Map<string, string>()
            try {
                const currentBlock = await provider.getBlockNumber()
                const deployEvents: any[] = []
                for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
                    const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
                    const chunk = await factory.queryFilter(factory.filters.ElectionDeployed(), from, to)
                    deployEvents.push(...chunk)
                }
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
                if (validMembers.length < 2) throw new Error("Need at least 2 committee members with valid addresses")
                if (threshold < 2 || threshold > validMembers.length) throw new Error("Invalid threshold")
                pkX = "0"
                pkY = "0"
            } else {
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
            if (gaslessMode || gateType === "invite-codes" || gateType === "allowlist" || gateType === "email-domain" || gateType === "github-org") metaObj.gaslessEnabled = true
            // Token gate: wallet required for balance check, but signup tx can still be relayed
            if (gateType === "token-gate") metaObj.gaslessEnabled = false
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
            // Email domain gate: store allowed domains in metadata
            if (gateType === "email-domain") {
                const domains = emailDomains.split(",").map(d => d.trim().toLowerCase()).filter(Boolean)
                if (domains.length === 0) throw new Error("At least one email domain required")
                metaObj.gateType = "email-domain"
                metaObj.emailDomain = { domains }
            }
            // GitHub org gate: store org name in metadata
            if (gateType === "github-org") {
                const org = githubOrg.trim()
                if (!org) throw new Error("GitHub organization name required")
                metaObj.gateType = "github-org"
                metaObj.githubOrg = { org }
            }
            // Token gate: store token contract info in metadata
            if (gateType === "token-gate") {
                if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) throw new Error("Invalid token contract address")
                metaObj.gateType = "token-gate"
                metaObj.tokenGate = {
                    tokenAddress: tokenAddress.toLowerCase(),
                    tokenType,
                    minBalance: tokenMinBalance || "1",
                    tokenSymbol: tokenSymbol || "",
                    tokenDecimals,
                }
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

                const election = new Contract(electionAddr, SPECTRE_VOTING_ABI, signer)
                const memberAddresses = validMembers.map(m => m.address.trim())
                const tx2 = await election.setupCommittee(threshold, memberAddresses)
                addLog(`Committee tx sent: ${tx2.hash.slice(0, 16)}...`)
                await tx2.wait()

                addLog(`Committee configured! Members must register keys on the election page.`)
            } else {
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
            setTokenAddress("")
            setTokenType("erc20")
            setTokenMinBalance("1")
            setTokenSymbol("")
            setTokenDecimals(18)
            setEmailDomains("")
            setGithubOrg("")
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
    }, [signer, electionTitle, optionLabels, signupHours, votingHours, selfSignup, gaslessMode, encryptionMode, committeMembers, threshold, addLog, loadElections, gateType, codeCount, allowlistInput, tokenAddress, tokenType, tokenMinBalance, tokenSymbol, tokenDecimals, emailDomains, githubOrg])

    // Handle "+ New" click — in Simple mode, connect wallet first if needed
    const handleNewClick = () => {
        if (!address) {
            connectWallet()
            return
        }
        setShowCreate(!showCreate)
    }

    return (
        <>
            {/* Elections header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>Elections</h3>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-secondary" onClick={loadElections} style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}>
                        Refresh
                    </button>
                    {(address || isSimple) && (
                        <button className="btn-primary" onClick={handleNewClick} style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}>
                            + New
                        </button>
                    )}
                </div>
            </div>

            {/* Simple mode: wallet prompt when creating without connection */}
            {isSimple && !address && showCreate && (
                <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 8 }}>
                        Connect your wallet to create elections. Your voters won&apos;t need one.
                    </p>
                    <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 200 }}>
                        Connect Wallet
                    </button>
                </div>
            )}

            {/* Create election form — conditional on mode */}
            {showCreate && address && (
                isSimple ? (
                    <CreateSimpleForm
                        electionTitle={electionTitle}
                        setElectionTitle={setElectionTitle}
                        optionLabels={optionLabels}
                        addOption={addOption}
                        removeOption={removeOption}
                        updateOption={updateOption}
                        gateType={gateType}
                        setGateType={setGateType}
                        codeCount={codeCount}
                        setCodeCount={setCodeCount}
                        allowlistInput={allowlistInput}
                        setAllowlistInput={setAllowlistInput}
                        tokenAddress={tokenAddress}
                        setTokenAddress={setTokenAddress}
                        tokenType={tokenType}
                        setTokenType={setTokenType}
                        tokenMinBalance={tokenMinBalance}
                        setTokenMinBalance={setTokenMinBalance}
                        tokenSymbol={tokenSymbol}
                        tokenDecimals={tokenDecimals}
                        emailDomains={emailDomains}
                        setEmailDomains={setEmailDomains}
                        githubOrg={githubOrg}
                        setGithubOrg={setGithubOrg}
                        creating={creating}
                        onSubmit={createElection}
                        setSignupHours={setSignupHours}
                        setVotingHours={setVotingHours}
                        setGaslessMode={setGaslessMode}
                        setEncryptionMode={setEncryptionMode}
                    />
                ) : (
                    /* Advanced mode: full creation form */
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

                            {/* Signup gate selector — using extracted component */}
                            <GateSelector
                                gateType={gateType}
                                setGateType={setGateType}
                                codeCount={codeCount}
                                setCodeCount={setCodeCount}
                                allowlistInput={allowlistInput}
                                setAllowlistInput={setAllowlistInput}
                                tokenAddress={tokenAddress}
                                setTokenAddress={setTokenAddress}
                                tokenType={tokenType}
                                setTokenType={setTokenType}
                                tokenMinBalance={tokenMinBalance}
                                setTokenMinBalance={setTokenMinBalance}
                                tokenSymbol={tokenSymbol}
                                tokenDecimals={tokenDecimals}
                                emailDomains={emailDomains}
                                setEmailDomains={setEmailDomains}
                                githubOrg={githubOrg}
                                setGithubOrg={setGithubOrg}
                                disabled={creating}
                            />

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
                            {gaslessMode && (
                                <TrustCallout
                                    text="Server-side relayer submits transactions on behalf of voters. Trust assumptions: liveness (relayer will submit), timeliness (relayer submits promptly), transport privacy (relayer won't correlate IPs with proofs). Voters independently verify their vote landed on-chain."
                                    variant="info"
                                />
                            )}

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
                                <TrustCallout
                                    text={encryptionMode === "single"
                                        ? "Election key stored in this browser\u2019s localStorage. You alone control when results are revealed. You can back up the key from the Results tab."
                                        : `Key split via Shamir secret sharing. ${threshold}-of-${committeMembers.length} members must cooperate to decrypt results. No single member can reveal votes alone.`}
                                    variant={encryptionMode === "single" ? "info" : "info"}
                                />
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

                            {/* Contextual warnings (Advanced mode) */}
                            <ContextualWarnings config={{
                                gateType,
                                gaslessMode: gaslessMode || gateType === "invite-codes" || gateType === "allowlist",
                                encryptionMode,
                                signupHours: Number(signupHours) || 24,
                                votingHours: Number(votingHours) || 72,
                                numOptions: optionLabels.length,
                                threshold: encryptionMode === "threshold" ? threshold : undefined,
                                totalMembers: encryptionMode === "threshold" ? committeMembers.filter(m => m.name.trim() && isAddress(m.address.trim())).length : undefined,
                            }} />
                        </div>
                        {/* Trust summary strip */}
                        <TrustSummary
                            gateType={gateType}
                            gaslessMode={gaslessMode || gateType === "invite-codes" || gateType === "allowlist"}
                            encryptionMode={encryptionMode}
                            threshold={encryptionMode === "threshold" ? threshold : undefined}
                            totalMembers={encryptionMode === "threshold" ? committeMembers.filter(m => m.name.trim() && isAddress(m.address.trim())).length : undefined}
                        />

                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
                            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", flex: 1 }}>
                                Signup: {signupHours}h · Voting: {votingHours}h · Share link auto-copied
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
                )
            )}

            {/* Post-creation modals */}
            {showCodesModal && generatedCodes.length > 0 && (
                <CodesModal
                    codes={generatedCodes}
                    onClose={() => setShowCodesModal(false)}
                    copied={copied}
                    onCopy={copyToClipboard}
                />
            )}

            {showAllowlistModal && allowlistIdentifiers.length > 0 && (
                <AllowlistModal
                    identifiers={allowlistIdentifiers}
                    onClose={() => setShowAllowlistModal(false)}
                    copied={copied}
                    onCopy={copyToClipboard}
                />
            )}

            {/* Connect wallet prompt (Advanced mode only — Simple mode handles it contextually) */}
            {!isSimple && !address && (
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
            <ElectionList elections={elections} loading={loadingElections} />
        </>
    )
}
