"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback } from "react"
import { Contract, JsonRpcProvider, toUtf8Bytes, toUtf8String, isAddress } from "ethers"
import { secp256k1 } from "@noble/curves/secp256k1"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, RPC_URL, MAX_LOG_RANGE, FACTORY_DEPLOY_BLOCK } from "@/lib/contracts"
import { friendlyError } from "@/lib/errors"
import { generateCodes, hashCodes, storeAdminCodes, hashIdentifiers, storeAdminAllowlist } from "@/lib/inviteCodes"
import { useElectionForm } from "@/hooks/useElectionForm"
import CreateElectionWizard from "@/components/CreateElectionWizard"
import CodesModal from "@/components/CodesModal"
import AllowlistModal from "@/components/AllowlistModal"
import ElectionList from "@/components/ElectionList"

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
    const [showCreate, setShowCreate] = useState(false)

    // Election creation form (all state in hook)
    const {
        state: formState,
        dispatch,
        selfSignup,
        effectiveGasless,
        gaslessLocked,
        walletForced,
        gaslessForced,
        validCommitteeMembers,
        canProceedFromStep,
        canCreate,
    } = useElectionForm()

    const copyToClipboard = (text: string, label: string) => {
        navigator.clipboard.writeText(text)
        setCopied(label)
        setTimeout(() => setCopied(""), 2000)
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
        if (!signer || !formState.electionTitle.trim()) return
        dispatch({ type: "SET_CREATING", creating: true })
        try {
            const proposalId = Math.floor(Date.now() / 1000)
            let pkX: string, pkY: string
            let privKeyHex: string | null = null

            const validMembers = formState.encryptionMode === "threshold"
                ? formState.committeeMembers.filter(m => m.name.trim() && isAddress(m.address.trim()))
                : []

            if (formState.encryptionMode === "threshold") {
                if (validMembers.length < 2) throw new Error("Need at least 2 committee members with valid addresses")
                if (formState.threshold < 2 || formState.threshold > validMembers.length) throw new Error("Invalid threshold")
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
            if (formState.signupHours && Number(formState.signupHours) > 0) {
                signupDeadline = BigInt(Math.floor(Date.now() / 1000) + Number(formState.signupHours) * 3600)
            }
            let votingDeadline = 0n
            if (formState.votingHours && Number(formState.votingHours) > 0) {
                votingDeadline = BigInt(Math.floor(Date.now() / 1000) + Number(formState.signupHours) * 3600 + Number(formState.votingHours) * 3600)
            }

            const numOptions = formState.optionLabels.length
            const labels = formState.optionLabels.map((l, i) => l.trim() || `Option ${i}`)

            // Build metadata JSON for on-chain storage
            const metaObj: Record<string, any> = { title: formState.electionTitle.trim(), labels }
            if (effectiveGasless) metaObj.gaslessEnabled = true
            // Token gate: wallet required for balance check
            if (formState.gateType === "token-gate") metaObj.gaslessEnabled = false
            // Invite code gate: generate codes, hash them, add to metadata
            let inviteCodes: string[] = []
            if (formState.gateType === "invite-codes") {
                const count = Math.max(2, Math.min(250, Number(formState.codeCount) || 20))
                inviteCodes = generateCodes(count)
                const codeHashes = hashCodes(inviteCodes)
                metaObj.gateType = "invite-codes"
                metaObj.inviteCodes = { totalCodes: count, codeHashes }
            }
            // Allowlist gate: parse identifiers, hash them, add to metadata
            let parsedAllowlist: string[] = []
            if (formState.gateType === "allowlist") {
                parsedAllowlist = [...new Set(formState.allowlistInput.split("\n").map(s => s.trim()).filter(Boolean))]
                if (parsedAllowlist.length < 2) throw new Error("Need at least 2 allowlist entries")
                const allowlistHashes = hashIdentifiers(parsedAllowlist)
                metaObj.gateType = "allowlist"
                metaObj.allowlist = { totalEntries: parsedAllowlist.length, identifierHashes: allowlistHashes }
            }
            // Email domain gate: store allowed domains in metadata
            if (formState.gateType === "email-domain") {
                const domains = formState.emailDomains.split(",").map(d => d.trim().toLowerCase()).filter(Boolean)
                if (domains.length === 0) throw new Error("At least one email domain required")
                metaObj.gateType = "email-domain"
                metaObj.emailDomain = { domains }
            }
            // GitHub org gate: store org name in metadata
            if (formState.gateType === "github-org") {
                const org = formState.githubOrg.trim()
                if (!org) throw new Error("GitHub organization name required")
                metaObj.gateType = "github-org"
                metaObj.githubOrg = { org }
            }
            // Token gate: store token contract info in metadata
            if (formState.gateType === "token-gate") {
                if (!formState.tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(formState.tokenAddress)) throw new Error("Invalid token contract address")
                metaObj.gateType = "token-gate"
                metaObj.tokenGate = {
                    tokenAddress: formState.tokenAddress.toLowerCase(),
                    tokenType: formState.tokenType,
                    minBalance: formState.tokenMinBalance || "1",
                    tokenSymbol: formState.tokenSymbol || "",
                    tokenDecimals: formState.tokenDecimals,
                    weighted: formState.weightedVoting,
                    ...(formState.weightedVoting && formState.tokenType === "erc20" && formState.voteThreshold ? { voteThreshold: formState.voteThreshold } : {}),
                }
            }
            if (formState.encryptionMode === "threshold") {
                metaObj.mode = "threshold"
                metaObj.threshold = formState.threshold
                metaObj.totalShares = validMembers.length
                metaObj.committee = validMembers.map(m => ({ name: m.name.trim(), address: m.address.trim() }))
            }
            const metadataBytes = toUtf8Bytes(JSON.stringify(metaObj))

            addLog("Creating election via factory...")
            const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, signer)
            const fee = await factory.creationFee()
            const tx = await factory.createElection(proposalId, pkX, pkY, signupDeadline, votingDeadline, numOptions, selfSignup, metadataBytes, { value: fee })
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

            // Store invite codes in localStorage
            if (formState.gateType === "invite-codes" && inviteCodes.length > 0) {
                storeAdminCodes(electionAddr, inviteCodes)
            }
            // Store allowlist identifiers in localStorage
            if (formState.gateType === "allowlist" && parsedAllowlist.length > 0) {
                storeAdminAllowlist(electionAddr, parsedAllowlist)
            }

            if (formState.encryptionMode === "threshold") {
                addLog(`Election created. Setting up ${formState.threshold}-of-${validMembers.length} committee...`)

                const election = new Contract(electionAddr, SPECTRE_VOTING_ABI, signer)
                const memberAddresses = validMembers.map(m => m.address.trim())
                const tx2 = await election.setupCommittee(formState.threshold, memberAddresses)
                addLog(`Committee tx sent: ${tx2.hash.slice(0, 16)}...`)
                await tx2.wait()

                addLog(`Committee configured! Members must register keys on the election page.`)
            } else {
                if (privKeyHex) {
                    localStorage.setItem(`spectre-election-key-${electionAddr}`, privKeyHex)
                }
                addLog(`Election created: "${formState.electionTitle.trim()}" (${numOptions} options)`)
            }

            // Copy share link
            const shareUrl = `${window.location.origin}/election/${electionAddr}`
            navigator.clipboard.writeText(shareUrl)
            addLog("Share link copied to clipboard!")

            // Show post-creation modals
            dispatch({
                type: "POST_CREATE",
                codes: formState.gateType === "invite-codes" ? inviteCodes : undefined,
                identifiers: formState.gateType === "allowlist" ? parsedAllowlist : undefined,
            })

            setShowCreate(false)
            await loadElections()

        } catch (err: any) {
            addLog(`Failed: ${friendlyError(err)}`)
        } finally {
            dispatch({ type: "SET_CREATING", creating: false })
        }
    }, [signer, formState, selfSignup, effectiveGasless, addLog, loadElections, dispatch])

    // Handle "+ New" click
    const handleNewClick = () => {
        if (!address) {
            connectWallet()
            return
        }
        if (showCreate) {
            dispatch({ type: "RESET" })
        }
        setShowCreate(!showCreate)
    }

    return (
        <>
            {/* Hero section */}
            <div style={{ textAlign: "center", padding: "32px 0 28px" }}>
                <h2 style={{ fontSize: "2rem", fontWeight: 800, lineHeight: 1.15, marginBottom: 14, letterSpacing: "-0.03em" }}>
                    Private voting,<br />verified results
                </h2>
                <p style={{ fontSize: "1.1rem", color: "var(--text-muted)", lineHeight: 1.5, maxWidth: 400, margin: "0 auto 32px" }}>
                    Run elections where no one can see how you voted — not even the admin. Results are mathematically verified.
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "left" }}>
                    {[
                        { icon: "\u{1F6E1}", title: "Anonymous", desc: "Your identity is cryptographically separated from your vote — nobody can connect the two" },
                        { icon: "\u{1F512}", title: "Encrypted", desc: "Votes stay sealed until the election ends — no early peeking" },
                        { icon: "\u2705", title: "Verifiable", desc: "Anyone can independently confirm the results are correct" },
                        { icon: "\u26A1", title: "No wallet needed", desc: "Voters just open a link and vote — no crypto, no downloads, works in any browser" },
                    ].map(g => (
                        <div key={g.title} style={{
                            display: "flex", alignItems: "center", gap: 16,
                            padding: "16px 18px",
                            background: "var(--bg-card)",
                            borderRadius: "var(--radius)",
                            border: "1px solid var(--border)",
                        }}>
                            <span style={{ fontSize: "1.6rem", flexShrink: 0 }}>{g.icon}</span>
                            <div>
                                <span style={{ fontSize: "1rem", fontWeight: 700 }}>{g.title}</span>
                                <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", marginTop: 3 }}>{g.desc}</p>
                            </div>
                        </div>
                    ))}
                </div>

            </div>

            {/* Elections header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>Elections</h3>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-secondary" onClick={loadElections} style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}>
                        Refresh
                    </button>
                    <button className="btn-primary" onClick={handleNewClick} style={{ width: "auto", padding: "6px 14px", fontSize: "0.75rem" }}>
                        + New
                    </button>
                </div>
            </div>

            {/* Wallet prompt when creating without connection */}
            {!address && showCreate && (
                <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 8 }}>
                        Connect your wallet to create elections. Your voters won&apos;t need one.
                    </p>
                    <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 200 }}>
                        Connect Wallet
                    </button>
                </div>
            )}

            {/* Create election wizard */}
            {showCreate && address && (
                <CreateElectionWizard
                    state={formState}
                    dispatch={dispatch}
                    effectiveGasless={effectiveGasless}
                    gaslessLocked={gaslessLocked}
                    walletForced={walletForced}
                    gaslessForced={gaslessForced}
                    validCommitteeMembers={validCommitteeMembers}
                    canProceedFromStep={canProceedFromStep}
                    canCreate={canCreate}
                    onCreateElection={createElection}
                />
            )}

            {/* Post-creation modals */}
            {formState.showCodesModal && formState.generatedCodes.length > 0 && (
                <CodesModal
                    codes={formState.generatedCodes}
                    onClose={() => dispatch({ type: "CLOSE_MODAL", modal: "codes" })}
                    copied={copied}
                    onCopy={copyToClipboard}
                />
            )}

            {formState.showAllowlistModal && formState.allowlistIdentifiers.length > 0 && (
                <AllowlistModal
                    identifiers={formState.allowlistIdentifiers}
                    onClose={() => dispatch({ type: "CLOSE_MODAL", modal: "allowlist" })}
                    copied={copied}
                    onCopy={copyToClipboard}
                />
            )}

            {/* Your elections (wallet connected) */}
            {address && (() => {
                const yours = elections.filter(e => e.admin.toLowerCase() === address.toLowerCase())
                return yours.length > 0 ? (
                    <>
                        <div style={{ marginBottom: 6, marginTop: 4 }}>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
                                Your elections
                            </span>
                        </div>
                        <ElectionList elections={yours} loading={false} />
                        {elections.length > yours.length && (
                            <div style={{ marginBottom: 6, marginTop: 16 }}>
                                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
                                    All elections
                                </span>
                            </div>
                        )}
                    </>
                ) : null
            })()}

            {/* Election list */}
            <ElectionList
                elections={address
                    ? elections.filter(e => e.admin.toLowerCase() !== address.toLowerCase())
                    : elections}
                loading={loadingElections}
            />

            {/* Connect wallet prompt */}
            {!address && !showCreate && (
                <div className="card" style={{ marginBottom: 16, marginTop: 16, textAlign: "center" }}>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginBottom: 12 }}>
                        Connect your wallet to see your elections
                    </p>
                    <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 200 }}>
                        Connect Wallet
                    </button>
                </div>
            )}
        </>
    )
}
