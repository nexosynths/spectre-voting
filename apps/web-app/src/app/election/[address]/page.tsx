"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback, useMemo } from "react"
import { Contract, JsonRpcProvider, toUtf8String, keccak256, toUtf8Bytes } from "ethers"
import { Identity, Group } from "@semaphore-protocol/core"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { generateProofInBrowser } from "@/lib/proof"
import { generateAnonJoinProof } from "@/lib/anonJoinProof"
import { secp256k1 } from "@noble/curves/secp256k1"
import { eciesEncrypt, eciesDecrypt, encodeVotePayload, decodeVotePayload, compressPublicKey } from "@/lib/ecies"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, SEMAPHORE_ABI, RPC_URL, EXPLORER_URL, MAX_LOG_RANGE, FACTORY_DEPLOY_BLOCK } from "@/lib/contracts"
import { friendlyError } from "@/lib/errors"
import { relaySignUp, relayAnonJoin, relayCastVote, waitForRelayTx, verifyVoteOnChain, verifyJoinOnChain, verifySignupOnChain, randomTimingDelay, RelayError } from "@/lib/relayer"
import { validateCode, validateIdentifier } from "@/lib/inviteCodes"
import { setupElection, decryptShare, reconstructElectionKey, hexToShare, hexToEncryptedShare, shareToHex, encryptedShareToHex, generateCommitteeKeypair, deserializeShareFromHex, type Share, type CommitteeMember, type ElectionSetup } from "@/lib/threshold"
import { poseidon2 } from "poseidon-lite"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useMode } from "@/context/ModeContext"
import ElectionHeader from "@/components/election/ElectionHeader"
import SignupSection from "@/components/election/SignupSection"
import VotingSection from "@/components/election/VotingSection"
import ResultsTab from "@/components/election/ResultsTab"
import ManageTab from "@/components/election/ManageTab"

type Tab = "vote" | "results" | "manage" | "committee"
type Phase = "signup" | "voting" | "closed"
type VoteStep = "idle" | "fetching-signup-group" | "generating-join-proof" | "submitting-join" | "fetching-voting-group" | "generating-vote-proof" | "encrypting" | "submitting-vote" | "timing-delay" | "verifying" | "done" | "error"
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
    selfSignupAllowed: boolean
}

interface ElectionMeta {
    title: string
    labels: string[]
}

interface CommitteeState {
    threshold: number
    members: string[] // wallet addresses
    registeredKeyCount: number
    finalized: boolean
    submittedShareCount: number
    // Per-member details (populated lazily)
    memberPubKeys: { [addr: string]: string } // hex
    memberHasSubmittedShare: { [addr: string]: boolean }
}

/** Get members from a Semaphore group by querying events */
async function fetchGroupMembers(groupId: bigint): Promise<bigint[]> {
    const provider = new JsonRpcProvider(RPC_URL)
    const sem = new Contract(CONTRACTS.SEMAPHORE, SEMAPHORE_ABI, provider)
    const currentBlock = await provider.getBlockNumber()

    // Paginate for Base 10k block limit
    const singles: any[] = []
    const bulks: any[] = []
    for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
        const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
        const [s, b] = await Promise.all([
            sem.queryFilter(sem.filters.MemberAdded(groupId), from, to),
            sem.queryFilter(sem.filters.MembersAdded(groupId), from, to),
        ])
        singles.push(...s)
        bulks.push(...b)
    }

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

/** Fetch election metadata from the factory's ElectionDeployed event */
async function fetchOnChainMetadata(electionAddress: string): Promise<Record<string, any> | null> {
    try {
        const provider = new JsonRpcProvider(RPC_URL)
        const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
        const currentBlock = await provider.getBlockNumber()

        // Paginate for Base 10k block limit
        let events: any[] = []
        for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
            const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
            const chunk = await factory.queryFilter(
                factory.filters.ElectionDeployed(electionAddress),
                from, to
            )
            events.push(...chunk)
            if (events.length > 0) break
        }

        if (events.length === 0) return null

        const args = (events[0] as any).args
        if (!args.metadata || args.metadata === "0x" || args.metadata.length <= 2) return null

        const decoded = toUtf8String(args.metadata)
        return JSON.parse(decoded)
    } catch {
        return null
    }
}

export default function ElectionPage({ params }: { params: { address: string } }) {
    const electionAddress = params.address
    const searchParams = useSearchParams()
    const { address, signer, connectWallet, addLog, anonymousId } = useSpectre()
    const { isSimple, isAdvanced } = useMode()

    // ── Per-election identity (scoped to election + wallet/anonymous session) ──
    const [identity, setIdentity] = useState<Identity | null>(null)

    // Gasless relay state (hoisted — used in identity loading effect)
    const [gaslessEnabled, setGaslessEnabled] = useState(false)

    // Recovery nudge state (gasless voters)
    const [showRecoveryNudge, setShowRecoveryNudge] = useState(false)
    const [recoveryCode, setRecoveryCode] = useState("")
    const [showRecoveryImport, setShowRecoveryImport] = useState(false)
    const [recoveryImportValue, setRecoveryImportValue] = useState("")
    const [recoveryError, setRecoveryError] = useState("")

    // Scope key: election address + wallet address (or anonymous ID for gasless)
    const identityStorageKey = useMemo(() => {
        const scope = address ? address.toLowerCase() : anonymousId ? `anon-${anonymousId}` : ""
        return scope ? `spectre-identity-${electionAddress}-${scope}` : ""
    }, [electionAddress, address, anonymousId])

    // Derive deterministic identity from wallet signature
    const deriveIdentityFromWallet = useCallback(async (): Promise<Identity | null> => {
        if (!signer) return null
        try {
            const msg = `Spectre identity for election ${electionAddress}`
            const signature = await signer.signMessage(msg)
            const seed = keccak256(toUtf8Bytes(signature))
            return new Identity(seed)
        } catch {
            return null // User rejected signing
        }
    }, [signer, electionAddress])

    // Load identity from localStorage on mount / key change
    useEffect(() => {
        if (!identityStorageKey) { setIdentity(null); return }
        const saved = localStorage.getItem(identityStorageKey)
        if (saved) {
            try { setIdentity(Identity.import(saved)); return } catch { localStorage.removeItem(identityStorageKey) }
        }
        // Auto-create identity for gasless voters (no user action needed)
        if (gaslessEnabled) {
            const id = new Identity()
            setIdentity(id)
            localStorage.setItem(identityStorageKey, id.export())
            addLog("Ready to participate")
            // Show recovery nudge (only once per election)
            const nudgeDismissed = localStorage.getItem(`spectre-nudge-dismissed-${electionAddress}`)
            if (!nudgeDismissed) {
                setRecoveryCode(id.export())
                setShowRecoveryNudge(true)
            }
            return
        }
        setIdentity(null)
    }, [identityStorageKey, gaslessEnabled, addLog, electionAddress])

    const createIdentity = useCallback(async () => {
        if (!identityStorageKey) { addLog("Connect your wallet first"); return }
        // Wallet users: derive deterministically from signature
        if (signer && !gaslessEnabled) {
            const derived = await deriveIdentityFromWallet()
            if (derived) {
                setIdentity(derived)
                localStorage.setItem(identityStorageKey, derived.export())
                addLog("Identity created from wallet")
                return
            }
            // User rejected signing — fall back to random identity + nudge
        }
        // Fallback: random identity (wallet rejection or no signer)
        const id = new Identity()
        setIdentity(id)
        localStorage.setItem(identityStorageKey, id.export())
        addLog("Ready to participate")
        const nudgeDismissed = localStorage.getItem(`spectre-nudge-dismissed-${electionAddress}`)
        if (!nudgeDismissed) {
            setRecoveryCode(id.export())
            setShowRecoveryNudge(true)
        }
    }, [identityStorageKey, addLog, signer, gaslessEnabled, deriveIdentityFromWallet, electionAddress])

    // Recovery import handler
    const handleRecoveryImport = useCallback(() => {
        if (!identityStorageKey || !recoveryImportValue.trim()) return
        try {
            const restored = Identity.import(recoveryImportValue.trim())
            setIdentity(restored)
            localStorage.setItem(identityStorageKey, restored.export())
            setShowRecoveryImport(false)
            setRecoveryImportValue("")
            setRecoveryError("")
            addLog("Identity restored from backup")
        } catch {
            setRecoveryError("Invalid recovery code")
        }
    }, [identityStorageKey, recoveryImportValue, addLog])

    // Dismiss recovery nudge
    const dismissRecoveryNudge = useCallback(() => {
        setShowRecoveryNudge(false)
        localStorage.setItem(`spectre-nudge-dismissed-${electionAddress}`, "1")
    }, [electionAddress])

    const [tab, setTab] = useState<Tab>("vote")
    const [state, setState] = useState<ElectionState | null>(null)
    const [loading, setLoading] = useState(true)
    const [copied, setCopied] = useState("")

    // Auto-switch from Committee tab when mode changes to Simple
    useEffect(() => {
        if (isSimple && tab === "committee") setTab("vote")
    }, [isSimple, tab])

    // Vote state
    const [selectedVote, setSelectedVote] = useState<number | null>(null)
    const [voteStep, setVoteStep] = useState<VoteStep>("idle")
    const [stepMsg, setStepMsg] = useState("")
    const [txHash, setTxHash] = useState("")
    const [error, setError] = useState("")

    // Gasless relay state (cont.)
    const [onChainVerified, setOnChainVerified] = useState<boolean | null>(null) // null = not checked, true/false = result

    // Signup state
    const [signupLoading, setSignupLoading] = useState(false)
    const [signupStatus, setSignupStatus] = useState<"unknown" | "checking" | "signed-up" | "not-signed-up">("unknown")

    // Invite code state
    const [inviteCode, setInviteCode] = useState("")
    const [codeValid, setCodeValid] = useState(false)
    const [codeError, setCodeError] = useState("")

    // Allowlist state
    const [allowlistId, setAllowlistId] = useState("")
    const [idValid, setIdValid] = useState(false)
    const [idError, setIdError] = useState("")

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

    // Threshold tally state
    const [thresholdShareInputs, setThresholdShareInputs] = useState<string[]>([])
    const [selectedMemberIdx, setSelectedMemberIdx] = useState(-1) // dropdown: "I am: [member]"
    const [decryptShareInput, setDecryptShareInput] = useState("") // encrypted share hex (auto-filled from dropdown)
    const [decryptKeyInput, setDecryptKeyInput] = useState("") // member private key hex
    const [decryptedShareResult, setDecryptedShareResult] = useState("")
    const [decryptShareError, setDecryptShareError] = useState("")

    // Tally commitment state
    const [commitStep, setCommitStep] = useState<"idle" | "submitting" | "done" | "error">("idle")
    const [commitError, setCommitError] = useState("")
    const [commitTxHash, setCommitTxHash] = useState("")
    const [onChainTally, setOnChainTally] = useState<{
        committed: boolean
        poseidonCommitment: string
        totalValid: number
        totalInvalid: number
        optionCounts: number[]
    } | null>(null)

    // Committee state
    const [committeeState, setCommitteeState] = useState<CommitteeState | null>(null)
    const [committeeLoading, setCommitteeLoading] = useState(false)
    const [committeeMsg, setCommitteeMsg] = useState("")
    const [committeeError, setCommitteeError] = useState("")

    // ── ELECTION METADATA ──
    // Sync init from localStorage/URL params (instant), then async upgrade from on-chain
    const [meta, setMeta] = useState<ElectionMeta>(() => {
        const urlTitle = searchParams.get("t")
        const urlLabels = searchParams.get("labels")
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

        if ((urlTitle || urlLabels) && !stored.title) {
            localStorage.setItem(`spectre-election-meta-${electionAddress}`, JSON.stringify({ title, labels }))
        }

        return { title, labels }
    })

    const [metaLoaded, setMetaLoaded] = useState(false)

    // Async upgrade: fetch authoritative metadata from on-chain event
    useEffect(() => {
        fetchOnChainMetadata(electionAddress).then(onChain => {
            if (onChain) {
                // Cache full on-chain metadata in localStorage (includes threshold data)
                localStorage.setItem(`spectre-election-meta-${electionAddress}`, JSON.stringify(onChain))
                setMeta({
                    title: onChain.title || meta.title || "",
                    labels: (onChain.labels && onChain.labels.length > 0) ? onChain.labels : meta.labels,
                })
                // Read gasless mode from metadata
                if (onChain.gaslessEnabled) setGaslessEnabled(true)
                // Invite-code and allowlist elections force gasless
                if (onChain.gateType === "invite-codes") setGaslessEnabled(true)
                if (onChain.gateType === "allowlist") setGaslessEnabled(true)
            }
            setMetaLoaded(true)
        })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress])

    // Auto-fill invite code from URL param
    useEffect(() => {
        const urlCode = searchParams.get("code")
        if (urlCode && !inviteCode) {
            setInviteCode(urlCode.toLowerCase().trim())
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams])

    // Auto-fill allowlist identifier from URL param
    useEffect(() => {
        const urlId = searchParams.get("id")
        if (urlId && !allowlistId) {
            setAllowlistId(decodeURIComponent(urlId))
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams])

    const displayTitle = meta.title || (state ? `Proposal #${state.proposalId}` : "Election")

    // Threshold detection from localStorage (reactive to on-chain metadata loading)
    const thresholdMeta = useMemo(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
            if (stored.mode === "threshold") {
                return {
                    threshold: stored.threshold as number,
                    totalShares: stored.totalShares as number,
                    committee: stored.committee as Array<{ id: string; publicKeyHex: string }>,
                    encryptedShares: stored.encryptedShares as Array<{ memberId: string; shareIndex: string; encryptedDataHex: string }>,
                }
            }
        } catch { /* ignore */ }
        return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress, metaLoaded])

    const isThresholdElection = thresholdMeta !== null

    // Invite code metadata detection
    const inviteCodeMeta = useMemo(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
            if (stored.gateType === "invite-codes" && stored.inviteCodes) {
                return {
                    totalCodes: stored.inviteCodes.totalCodes as number,
                    codeHashes: stored.inviteCodes.codeHashes as string[],
                }
            }
        } catch { /* ignore */ }
        return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress, metaLoaded])

    const isInviteCodeElection = inviteCodeMeta !== null

    // Allowlist metadata detection
    const allowlistMeta = useMemo(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
            if (stored.gateType === "allowlist" && stored.allowlist) {
                return {
                    totalEntries: stored.allowlist.totalEntries as number,
                    identifierHashes: stored.allowlist.identifierHashes as string[],
                }
            }
        } catch { /* ignore */ }
        return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress, metaLoaded])

    const isAllowlistElection = allowlistMeta !== null

    // Validate allowlist identifier client-side
    useEffect(() => {
        if (!allowlistMeta || !allowlistId.trim()) {
            setIdValid(false)
            setIdError("")
            return
        }
        const match = validateIdentifier(allowlistId, allowlistMeta.identifierHashes)
        if (match) {
            setIdValid(true)
            setIdError("")
        } else {
            setIdValid(false)
            setIdError("Not on the allowlist")
        }
    }, [allowlistId, allowlistMeta])

    // Validate invite code client-side
    useEffect(() => {
        if (!inviteCodeMeta || !inviteCode) {
            setCodeValid(false)
            setCodeError("")
            return
        }
        const normalized = inviteCode.toLowerCase().trim()
        if (normalized.length === 0) {
            setCodeValid(false)
            setCodeError("")
            return
        }
        if (!/^[0-9a-f]{8}$/.test(normalized)) {
            setCodeValid(false)
            setCodeError("Code must be 8 characters (letters a-f, numbers 0-9)")
            return
        }
        const match = validateCode(normalized, inviteCodeMeta.codeHashes)
        if (match) {
            setCodeValid(true)
            setCodeError("")
        } else {
            setCodeValid(false)
            setCodeError("Invalid invite code")
        }
    }, [inviteCode, inviteCodeMeta])

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
    // Per-election AND per-wallet/anonymous — each scope gets its own delinked voting identity
    const votingIdentityKey = address
        ? `spectre-voting-identity-${electionAddress}-${address.toLowerCase()}`
        : anonymousId
            ? `spectre-voting-identity-${electionAddress}-anon-${anonymousId}`
            : ""

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
            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const [pid, sOpen, vOpen, vc, sgid, vgid, admin, pkX, pkY, sdl, vdl, numOpt, selfSignup] = await Promise.all([
                c.proposalId(), c.signupOpen(), c.votingOpen(), c.voteCount(),
                c.signupGroupId(), c.votingGroupId(),
                c.admin(), c.electionPubKeyX(), c.electionPubKeyY(),
                c.signupDeadline(), c.votingDeadline(), c.numOptions(),
                c.selfSignupAllowed().catch(() => true), // fallback for old contracts
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
                selfSignupAllowed: selfSignup,
            })

            // Fetch on-chain tally commitment (try/catch for backward compat with old contracts)
            try {
                const committed = await c.tallyCommitted()
                if (committed) {
                    const [posCommit, tv, ti, oc] = await Promise.all([
                        c.tallyPoseidonCommitment(),
                        c.tallyTotalValid(),
                        c.tallyTotalInvalid(),
                        c.getTallyOptionCounts(),
                    ])
                    setOnChainTally({
                        committed: true,
                        poseidonCommitment: posCommit.toString(),
                        totalValid: Number(tv),
                        totalInvalid: Number(ti),
                        optionCounts: oc.map((x: bigint) => Number(x)),
                    })
                } else {
                    setOnChainTally({ committed: false, poseidonCommitment: "", totalValid: 0, totalInvalid: 0, optionCounts: [] })
                }
            } catch {
                setOnChainTally(null) // old contract without commitTallyResult
            }

            // Fetch on-chain committee state
            try {
                const cThreshold = await c.committeeThreshold()
                const threshold = Number(cThreshold)
                if (threshold > 0) {
                    const [members, regCount, finalized, shareCount] = await Promise.all([
                        c.getCommitteeMembers(),
                        c.registeredKeyCount(),
                        c.committeeFinalized(),
                        c.submittedShareCount(),
                    ])
                    // Fetch per-member details (parallel)
                    const memberPubKeys: { [addr: string]: string } = {}
                    const memberHasSubmitted: { [addr: string]: boolean } = {}
                    const memberDetails = await Promise.all(
                        members.map((m: string) => Promise.all([
                            c.committeePublicKeys(m),
                            c.hasSubmittedShare(m),
                        ]))
                    )
                    members.forEach((m: string, i: number) => {
                        memberPubKeys[m.toLowerCase()] = memberDetails[i][0]
                        memberHasSubmitted[m.toLowerCase()] = memberDetails[i][1]
                    })
                    setCommitteeState({
                        threshold,
                        members: members.map((m: string) => m),
                        registeredKeyCount: Number(regCount),
                        finalized,
                        submittedShareCount: Number(shareCount),
                        memberPubKeys,
                        memberHasSubmittedShare: memberHasSubmitted,
                    })
                } else {
                    setCommitteeState(null)
                }
            } catch {
                setCommitteeState(null)
            }
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
        if (!identity || !state) return
        // Invite code validation check
        if (isInviteCodeElection && !codeValid) {
            addLog("Valid invite code required to sign up")
            return
        }
        // Allowlist validation check
        if (isAllowlistElection && !idValid) {
            addLog("Valid identifier required to sign up")
            return
        }
        const codeToSend = isInviteCodeElection ? inviteCode.toLowerCase().trim() : undefined
        const identifierToSend = isAllowlistElection ? allowlistId.trim() : undefined
        // Gasless mode: relay signup (no wallet needed)
        if (gaslessEnabled) {
            setSignupLoading(true)
            try {
                addLog("Relaying signup...")
                const txHash = await relaySignUp(electionAddress, identity.commitment, codeToSend, identifierToSend)
                addLog(`Signup relayed — tx: ${txHash.slice(0, 10)}...`)
                await waitForRelayTx(txHash)
                const verified = await verifySignupOnChain(electionAddress, identity.commitment.toString(), txHash)
                if (!verified) addLog("Warning: signup event not found on-chain")
                addLog("Signed up for election!")
                setSignupStatus("signed-up")
                await refresh()
            } catch (err: any) {
                addLog(`Signup failed: ${err instanceof RelayError ? err.message : friendlyError(err)}`)
            } finally { setSignupLoading(false) }
            return
        }
        // Wallet mode: direct tx
        if (!signer) return
        setSignupLoading(true)
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.signUp(identity.commitment)
            await tx.wait()
            addLog("Signed up for election!")
            setSignupStatus("signed-up")
            await refresh()
        } catch (err: any) {
            addLog(`Signup failed: ${friendlyError(err)}`)
        } finally { setSignupLoading(false) }
    }, [identity, signer, state, electionAddress, addLog, refresh, gaslessEnabled, isInviteCodeElection, codeValid, inviteCode, isAllowlistElection, idValid, allowlistId])

    // ── ANONYMOUS JOIN + VOTE (Phase 2) ──
    const handleJoinAndVote = useCallback(async () => {
        if (!identity || selectedVote === null || !state) return
        // Wallet mode requires signer
        if (!gaslessEnabled && !signer) return
        setError(""); setTxHash(""); setOnChainVerified(null)
        try {
            // Step 1: Check if we need to anonymous join first
            let votingId = getVotingIdentity()
            const needsJoin = joinStatus !== "joined"

            if (needsJoin) {
                // Create per-election voting identity if not exists
                if (!votingId) {
                    votingId = createVotingIdentity()
                    addLog("Preparing anonymous vote...")
                }

                setVoteStep("fetching-signup-group"); setStepMsg("Fetching signup group...")
                const signupMembers = await fetchGroupMembers(BigInt(state.signupGroupId))
                const signupGroup = new Group()
                for (const m of signupMembers) signupGroup.addMember(m)
                addLog(`Checking registration (${signupMembers.length} registered)`)

                if (signupGroup.indexOf(identity.commitment) === -1) {
                    throw new Error("You're not registered for this election. You need to sign up during the registration phase.")
                }

                setVoteStep("generating-join-proof"); setStepMsg("Generating anonymous join proof (10-30s)...")
                addLog("Generating anonymous proof...")
                const joinProof = await generateAnonJoinProof(identity, votingId, signupGroup, BigInt(state.proposalId))
                addLog("Proof ready")

                if (gaslessEnabled) {
                    // ── GASLESS: relay anonJoin ──
                    setVoteStep("submitting-join"); setStepMsg("Relaying anonymous join...")
                    const joinTxHash = await relayAnonJoin(electionAddress, joinProof)
                    setStepMsg("Waiting for join confirmation...")
                    await waitForRelayTx(joinTxHash)
                    const joinVerified = await verifyJoinOnChain(electionAddress, joinProof.joinNullifier, joinTxHash)
                    if (!joinVerified) addLog("Warning: join event not verified on-chain")
                    addLog("Anonymous registration confirmed")

                    // IP-timing decorrelation: random delay before castVote
                    // Only applies in production — on localhost both calls come from same machine
                    if (window.location.hostname !== "localhost") {
                        setVoteStep("timing-delay"); setStepMsg("Securing your anonymity...")
                        addLog("Random delay to protect your identity (a few seconds)...")
                        await randomTimingDelay()
                    }
                } else {
                    // ── WALLET: direct tx ──
                    setVoteStep("submitting-join"); setStepMsg("Confirm anonymous join in wallet...")
                    const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer!)
                    const joinTx = await c.anonJoin(
                        joinProof.pA, joinProof.pB, joinProof.pC,
                        joinProof.signupMerkleRoot, joinProof.joinNullifier, joinProof.newCommitment
                    )
                    setStepMsg("Waiting for join confirmation...")
                    await joinTx.wait()
                    addLog("Anonymous registration confirmed")
                }
                setJoinStatus("joined")
            } else {
                if (!votingId) throw new Error("Something went wrong with your voting identity. Try refreshing the page.")
            }

            // Step 2: Cast vote
            setVoteStep("fetching-voting-group"); setStepMsg("Fetching voting group...")
            const votingMembers = await fetchGroupMembers(BigInt(state.votingGroupId))
            const votingGroup = new Group()
            for (const m of votingMembers) votingGroup.addMember(m)
            addLog(`Verified voters: ${votingMembers.length}`)

            if (votingGroup.indexOf(votingId!.commitment) === -1) {
                throw new Error("Your anonymous registration hasn't been confirmed yet. Try refreshing the page.")
            }

            setVoteStep("generating-vote-proof"); setStepMsg("Generating vote proof (10-30s)...")
            addLog("Generating vote proof...")

            const rnd = randomBytes(31)
            let voteRand = 0n
            for (const b of rnd) voteRand = (voteRand << 8n) | BigInt(b)

            const proof = await generateProofInBrowser(
                votingId!, votingGroup, BigInt(state.proposalId),
                BigInt(selectedVote), voteRand, BigInt(state.numOptions)
            )
            addLog("Proof ready")

            setVoteStep("encrypting"); setStepMsg("Encrypting vote...")
            const pubKey = compressPublicKey(BigInt(state.electionPubKeyX), BigInt(state.electionPubKeyY))
            const payload = encodeVotePayload(BigInt(selectedVote), voteRand)
            const blob = eciesEncrypt(pubKey, payload)

            if (gaslessEnabled) {
                // ── GASLESS: relay castVote ──
                setVoteStep("submitting-vote"); setStepMsg("Relaying encrypted vote...")
                const voteTxHash = await relayCastVote(electionAddress, proof, blob)
                setStepMsg("Waiting for vote confirmation...")
                const blockNum = await waitForRelayTx(voteTxHash)
                addLog("Vote submitted successfully")

                // Anti-censorship: independently verify on-chain
                setVoteStep("verifying"); setStepMsg("Verifying vote on-chain...")
                const verified = await verifyVoteOnChain(electionAddress, proof.nullifierHash, voteTxHash)
                setOnChainVerified(verified)
                if (verified) {
                    addLog("Vote verified on-chain!")
                } else {
                    addLog("Warning: vote not verified on-chain. Try refreshing later to check.")
                }

                setTxHash(voteTxHash); setVoteStep("done"); setStepMsg("")
            } else {
                // ── WALLET: direct tx ──
                setVoteStep("submitting-vote"); setStepMsg("Confirm vote in wallet...")
                const contract = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer!)
                const tx = await contract.castVote(
                    proof.pA, proof.pB, proof.pC,
                    proof.merkleRoot, proof.nullifierHash, proof.voteCommitment, blob
                )
                setStepMsg("Waiting for vote confirmation...")
                const receipt = await tx.wait()

                setTxHash(tx.hash); setVoteStep("done"); setStepMsg("")
                addLog("Vote confirmed")
            }
            await refresh()
        } catch (err: any) {
            const msg = err instanceof RelayError ? err.message : friendlyError(err)
            setError(msg); setVoteStep("error"); setStepMsg("")
            addLog(`Error: ${msg}`)
        }
    }, [identity, signer, selectedVote, state, electionAddress, addLog, refresh, joinStatus, getVotingIdentity, createVotingIdentity, gaslessEnabled])

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
        } catch (err: any) { setAdminMsg(`Error: ${friendlyError(err)}`) }
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
        } catch (err: any) { setAdminMsg(`Error: ${friendlyError(err)}`) }
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
        } catch (err: any) { setAdminMsg(`Error: ${friendlyError(err)}`) }
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
        } catch (err: any) { setAdminMsg(`Error: ${friendlyError(err)}`) }
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

            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const currentBlock = await provider.getBlockNumber()
            // Paginate for Base 10k block limit
            const events: any[] = []
            for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
                const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
                const chunk = await c.queryFilter(c.filters.VoteCast(), from, to)
                events.push(...chunk)
            }

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

    // ── THRESHOLD TALLY ──
    const handleDecryptShare = useCallback(() => {
        setDecryptShareError(""); setDecryptedShareResult("")
        try {
            if (!decryptShareInput.trim() || !decryptKeyInput.trim()) {
                throw new Error("Both encrypted share data and private key are required")
            }
            const encData = hexToEncryptedShare(decryptShareInput.trim())
            const privKeyBuf = new Uint8Array(32)
            const keyHex = decryptKeyInput.trim()
            for (let i = 0; i < 32; i++) {
                privKeyBuf[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16)
            }
            const share = decryptShare(privKeyBuf, encData)
            privKeyBuf.fill(0)
            const hex = shareToHex(share)
            setDecryptedShareResult(hex)
            // Auto-populate this member's slot in Section B
            if (selectedMemberIdx >= 0) {
                setThresholdShareInputs(prev => {
                    const next = [...prev]
                    next[selectedMemberIdx] = hex
                    return next
                })
            }
        } catch (err: any) {
            setDecryptShareError(err.message || "Decryption failed")
        }
    }, [decryptShareInput, decryptKeyInput, selectedMemberIdx])

    const runThresholdTally = useCallback(async () => {
        if (!state || !thresholdMeta) return
        setTallyError(""); setTallyResult(null)

        const validShares: Share[] = []
        for (const hex of thresholdShareInputs) {
            if (hex.trim().length === 128) {
                try { validShares.push(hexToShare(hex.trim())) } catch { /* skip invalid */ }
            }
        }

        if (validShares.length < thresholdMeta.threshold) {
            setTallyError(`Need at least ${thresholdMeta.threshold} shares, got ${validShares.length}`)
            setTallyStep("error"); return
        }

        try {
            // Reconstruct the election private key
            const electionPrivKey = reconstructElectionKey(validShares)

            setTallyStep("fetching"); setTallyMsg("Fetching votes from chain...")
            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const currentBlock = await provider.getBlockNumber()
            // Paginate for Base 10k block limit
            const events: any[] = []
            for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
                const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
                const chunk = await c.queryFilter(c.filters.VoteCast(), from, to)
                events.push(...chunk)
            }

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
                for (let i = 0; i < blob.length; i++) blob[i] = parseInt(blobHex.substring(i * 2, i * 2 + 2), 16)

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
            addLog(`Threshold tally: ${summary}`)
        } catch (err: any) {
            setTallyError(err.message || "Threshold tally failed"); setTallyStep("error"); setTallyMsg("")
        }
    }, [electionAddress, addLog, state, optionLabels, thresholdMeta, thresholdShareInputs])

    // ── COMMIT TALLY ON-CHAIN ──
    const handleCommitTally = useCallback(async () => {
        if (!signer || !tallyResult || !state) return
        setCommitError(""); setCommitTxHash("")
        setCommitStep("submitting")

        try {
            // Compute Poseidon commitment off-chain (hash chain)
            let hash = poseidon2([BigInt(tallyResult.totalValid), BigInt(tallyResult.totalInvalid)])
            for (const count of tallyResult.optionCounts) {
                hash = poseidon2([hash, BigInt(count)])
            }

            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.commitTallyResult(
                tallyResult.optionCounts,
                tallyResult.totalValid,
                tallyResult.totalInvalid,
                hash
            )
            await tx.wait()

            setCommitTxHash(tx.hash)
            setCommitStep("done")
            addLog("Tally committed on-chain!")
            await refresh()
        } catch (err: any) {
            setCommitError(friendlyError(err))
            setCommitStep("error")
        }
    }, [signer, tallyResult, state, electionAddress, addLog, refresh])

    // ── COMMITTEE ACTIONS ──
    const committeeKeyStorageKey = address
        ? `spectre-committee-key-${electionAddress}-${address.toLowerCase()}`
        : ""

    const hasStoredCommitteeKey = typeof window !== "undefined" && !!committeeKeyStorageKey && !!localStorage.getItem(committeeKeyStorageKey)

    // Generate key + register on-chain
    const handleRegisterCommitteeKey = useCallback(async () => {
        if (!signer || !address || !committeeState) return
        setCommitteeLoading(true); setCommitteeMsg(""); setCommitteeError("")
        try {
            // Generate fresh secp256k1 keypair
            const kp = generateCommitteeKeypair()
            addLog("Generated committee keypair")

            // Store private key in localStorage
            const storageKey = `spectre-committee-key-${electionAddress}-${address.toLowerCase()}`
            localStorage.setItem(storageKey, kp.privateKeyHex)

            // Convert hex pubkey to bytes for the contract
            const pubKeyBytes = "0x" + kp.publicKeyHex
            addLog("Registering public key on-chain...")

            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.registerCommitteeKey(pubKeyBytes)
            await tx.wait()

            setCommitteeMsg("Key registered! Your private key is saved in this browser.")
            addLog("Committee key registered on-chain")
            await refresh()
        } catch (err: any) {
            setCommitteeError(friendlyError(err))
        } finally { setCommitteeLoading(false) }
    }, [signer, address, committeeState, electionAddress, addLog, refresh])

    // Admin: run dealer ceremony + finalize committee
    const handleFinalizeCommittee = useCallback(async () => {
        if (!signer || !committeeState) return
        setCommitteeLoading(true); setCommitteeMsg(""); setCommitteeError("")
        try {
            // Read all registered public keys from chain
            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)

            const committee: CommitteeMember[] = []
            for (const memberAddr of committeeState.members) {
                const pubKeyHex: string = await c.committeePublicKeys(memberAddr)
                const clean = pubKeyHex.startsWith("0x") ? pubKeyHex.slice(2) : pubKeyHex
                const pubBuf = new Uint8Array(33)
                for (let i = 0; i < 33; i++) pubBuf[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
                committee.push({ id: memberAddr, publicKey: pubBuf })
            }

            addLog(`Running dealer ceremony (${committeeState.threshold}-of-${committee.length})...`)
            const electionSetup: ElectionSetup = setupElection(committee, committeeState.threshold)
            addLog("Dealer ceremony complete — master key discarded")

            // Get election pubkey coordinates
            const point = secp256k1.ProjectivePoint.fromHex(electionSetup.electionPubKey)
            const pkX = point.x.toString()
            const pkY = point.y.toString()

            // ABI-encode the encrypted shares as bytes
            const sharesData = electionSetup.encryptedShares.map(s => ({
                memberId: s.memberId,
                shareIndex: s.shareIndex.toString(),
                encryptedDataHex: encryptedShareToHex(s.encryptedData),
            }))
            const encSharesBytes = "0x" + Buffer.from(JSON.stringify(sharesData)).toString("hex")

            addLog("Finalizing committee on-chain...")
            const cSigner = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await cSigner.finalizeCommittee(pkX, pkY, encSharesBytes)
            await tx.wait()

            setCommitteeMsg("Committee finalized! Election public key set. Voting can now be opened.")
            addLog("Committee finalized on-chain")
            await refresh()
        } catch (err: any) {
            setCommitteeError(friendlyError(err))
        } finally { setCommitteeLoading(false) }
    }, [signer, committeeState, electionAddress, addLog, refresh])

    // Committee member: decrypt + submit share on-chain
    const handleSubmitDecryptedShare = useCallback(async () => {
        if (!signer || !address || !committeeState) return
        setCommitteeLoading(true); setCommitteeMsg(""); setCommitteeError("")
        try {
            // Get stored private key
            const storageKey = `spectre-committee-key-${electionAddress}-${address.toLowerCase()}`
            const privKeyHex = localStorage.getItem(storageKey)
            if (!privKeyHex) throw new Error("No committee private key found in this browser. Did you generate your key on a different device?")

            // Find our encrypted share from CommitteeFinalized event
            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const currentBlock = await provider.getBlockNumber()
            // Paginate for Base 10k block limit
            const events: any[] = []
            for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
                const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
                const chunk = await c.queryFilter(c.filters.CommitteeFinalized(), from, to)
                events.push(...chunk)
                if (events.length > 0) break
            }

            if (events.length === 0) throw new Error("CommitteeFinalized event not found")

            const args = (events[0] as any).args
            const encSharesHex = args.encryptedSharesData
            const clean = encSharesHex.startsWith("0x") ? encSharesHex.slice(2) : encSharesHex
            const sharesJson = Buffer.from(clean, "hex").toString("utf-8")
            const shares: Array<{ memberId: string; shareIndex: string; encryptedDataHex: string }> = JSON.parse(sharesJson)

            // Find our share (memberId is the address)
            const myShare = shares.find(s => s.memberId.toLowerCase() === address.toLowerCase())
            if (!myShare) throw new Error("Your encrypted share was not found in the finalization data")

            addLog("Decrypting your share...")
            const encData = hexToEncryptedShare(myShare.encryptedDataHex)
            const privKeyBuf = new Uint8Array(32)
            for (let i = 0; i < 32; i++) {
                privKeyBuf[i] = parseInt(privKeyHex.substring(i * 2, i * 2 + 2), 16)
            }
            const share = decryptShare(privKeyBuf, encData)
            privKeyBuf.fill(0)

            // Serialize share as bytes (64 bytes: x || y)
            const shareHex = shareToHex(share)
            const shareBytes = "0x" + shareHex

            addLog("Submitting decrypted share on-chain...")
            const cSigner = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await cSigner.submitDecryptedShare(shareBytes)
            await tx.wait()

            setCommitteeMsg("Share submitted on-chain!")
            addLog("Decrypted share submitted")
            await refresh()
        } catch (err: any) {
            setCommitteeError(friendlyError(err))
        } finally { setCommitteeLoading(false) }
    }, [signer, address, committeeState, electionAddress, addLog, refresh])

    // Auto-tally from on-chain shares (for committee elections)
    const runOnChainCommitteeTally = useCallback(async () => {
        if (!state || !committeeState) return
        setTallyError(""); setTallyResult(null)

        try {
            setTallyStep("fetching"); setTallyMsg("Reading shares from chain...")

            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)

            // Read submitted shares
            const validShares: Share[] = []
            for (const memberAddr of committeeState.members) {
                if (committeeState.memberHasSubmittedShare[memberAddr.toLowerCase()]) {
                    const shareBytes: string = await c.getDecryptedShare(memberAddr)
                    if (shareBytes && shareBytes !== "0x") {
                        try {
                            validShares.push(deserializeShareFromHex(shareBytes))
                        } catch { /* skip malformed share */ }
                    }
                }
            }

            if (validShares.length < committeeState.threshold) {
                setTallyError(`Need ${committeeState.threshold} shares, only ${validShares.length} submitted`)
                setTallyStep("error"); return
            }

            setTallyMsg("Reconstructing election key...")
            const electionPrivKey = reconstructElectionKey(validShares)

            setTallyMsg("Fetching votes from chain...")
            const currentBlock3 = await provider.getBlockNumber()
            // Paginate for Base 10k block limit
            const voteEvents: any[] = []
            for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock3; from += MAX_LOG_RANGE) {
                const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock3)
                const chunk = await c.queryFilter(c.filters.VoteCast(), from, to)
                voteEvents.push(...chunk)
            }

            if (voteEvents.length === 0) {
                setTallyResult({ optionCounts: new Array(state.numOptions).fill(0), totalValid: 0, totalInvalid: 0, duplicatesRemoved: 0, decryptedVotes: [] })
                setTallyStep("done"); setTallyMsg(""); return
            }

            setTallyStep("decrypting"); setTallyMsg(`Decrypting ${voteEvents.length} vote(s)...`)

            const decryptedVotes: DecryptedVote[] = []
            for (const event of voteEvents) {
                const args = (event as any).args
                const nullifierHash = args.nullifierHash.toString()
                const voteCommitment = args.voteCommitment.toString()
                const encryptedBlob = args.encryptedBlob
                const blobHex = encryptedBlob.startsWith("0x") ? encryptedBlob.slice(2) : encryptedBlob
                const blob = new Uint8Array(blobHex.length / 2)
                for (let i = 0; i < blob.length; i++) blob[i] = parseInt(blobHex.substring(i * 2, i * 2 + 2), 16)

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
            addLog(`Committee tally: ${summary}`)
        } catch (err: any) {
            setTallyError(err.message || "Committee tally failed"); setTallyStep("error"); setTallyMsg("")
        }
    }, [electionAddress, addLog, state, optionLabels, committeeState])

    // Initialize threshold share inputs when meta loads
    useEffect(() => {
        if (thresholdMeta && thresholdShareInputs.length === 0) {
            setThresholdShareInputs(new Array(thresholdMeta.totalShares).fill(""))
        }
    }, [thresholdMeta, thresholdShareInputs.length])

    // ── SHARE (clean URL — metadata is on-chain) ──
    const shareUrl = useMemo(() => {
        const base = typeof window !== "undefined" ? window.location.origin : ""
        return `${base}/election/${electionAddress}`
    }, [electionAddress])

    // Derived
    const isAdmin = address && state?.admin && address.toLowerCase() === state.admin.toLowerCase()
    const hasPubKey = state ? (state.electionPubKeyX !== "0" || state.electionPubKeyY !== "0") : false
    const isProcessing = !["idle", "done", "error"].includes(voteStep)

    const stepInfo = useMemo(() => {
        if (!isProcessing) return null
        const gasless = gaslessEnabled
        const steps: Record<string, { step: number; total: number; label: string }> = gasless ? {
            "fetching-signup-group":  { step: 1, total: 6, label: "Preparing..." },
            "generating-join-proof":  { step: 2, total: 6, label: "Proving your eligibility (~15s)" },
            "submitting-join":        { step: 3, total: 6, label: "Submitting anonymous registration" },
            "timing-delay":           { step: 3, total: 6, label: "Securing your anonymity..." },
            "fetching-voting-group":  { step: 4, total: 6, label: "Preparing your ballot..." },
            "generating-vote-proof":  { step: 5, total: 6, label: "Sealing your vote (~15s)" },
            "encrypting":             { step: 5, total: 6, label: "Encrypting your ballot" },
            "submitting-vote":        { step: 6, total: 6, label: "Submitting your encrypted vote" },
            "verifying":              { step: 6, total: 6, label: "Confirming on-chain..." },
        } : {
            "fetching-signup-group":  { step: 1, total: 5, label: "Preparing..." },
            "generating-join-proof":  { step: 2, total: 5, label: "Proving your eligibility (~15s)" },
            "submitting-join":        { step: 3, total: 5, label: "Confirm in wallet" },
            "fetching-voting-group":  { step: 3, total: 5, label: "Preparing your ballot..." },
            "generating-vote-proof":  { step: 4, total: 5, label: "Sealing your vote (~15s)" },
            "encrypting":             { step: 4, total: 5, label: "Encrypting your ballot" },
            "submitting-vote":        { step: 5, total: 5, label: "Confirm in wallet" },
        }
        return steps[voteStep] || null
    }, [voteStep, isProcessing, gaslessEnabled])
    const isOnChainCommittee = committeeState !== null && committeeState.threshold > 0
    const canVote = isOnChainCommittee ? (committeeState?.finalized ?? false) : hasPubKey
    const isMyCommitteeMember = !!(address && committeeState?.members.some(m => m.toLowerCase() === address.toLowerCase()))
    const myKeyRegistered = !!(address && committeeState?.memberPubKeys && (committeeState.memberPubKeys[address.toLowerCase()]?.length ?? 0) > 2) // "0x" means empty
    const myShareSubmitted = !!(address && committeeState?.memberHasSubmittedShare?.[address.toLowerCase()])
    const committeeSharesReady = !!(committeeState && committeeState.submittedShareCount >= committeeState.threshold)

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
            <ElectionHeader
                displayTitle={displayTitle}
                phase={phase}
                phaseBadge={phaseBadge}
                voteCount={state.voteCount}
                numOptions={state.numOptions}
                selfSignupAllowed={state.selfSignupAllowed}
                gaslessEnabled={gaslessEnabled}
                isInviteCodeElection={isInviteCodeElection}
                isAllowlistElection={isAllowlistElection}
                inviteCodeCount={inviteCodeMeta?.totalCodes ?? null}
                allowlistEntryCount={allowlistMeta?.totalEntries ?? null}
                isThresholdElection={isThresholdElection}
                thresholdMeta={thresholdMeta ? { threshold: thresholdMeta.threshold, totalShares: thresholdMeta.totalShares } : null}
                signupDeadline={state.signupDeadline}
                votingDeadline={state.votingDeadline}
                shareUrl={shareUrl}
                isOnChainCommittee={isOnChainCommittee}
                isAdmin={!!isAdmin}
                tab={tab}
                setTab={setTab}
                copyToClipboard={copyToClipboard}
                copied={copied}
            />

            {/* ═══ VOTE / SIGNUP TAB ═══ */}
            {tab === "vote" && (
                <>
                    <SignupSection
                        phase={phase}
                        gaslessEnabled={gaslessEnabled}
                        address={address}
                        identity={identity}
                        connectWallet={connectWallet}
                        createIdentity={createIdentity}
                        signupStatus={signupStatus}
                        signupLoading={signupLoading}
                        selfSignupAllowed={state.selfSignupAllowed}
                        isInviteCodeElection={isInviteCodeElection}
                        isAllowlistElection={isAllowlistElection}
                        inviteCode={inviteCode}
                        setInviteCode={setInviteCode}
                        codeValid={codeValid}
                        codeError={codeError}
                        allowlistId={allowlistId}
                        setAllowlistId={setAllowlistId}
                        idValid={idValid}
                        idError={idError}
                        identityCommitment={identity ? identity.commitment.toString() : ""}
                        handleSignUp={handleSignUp}
                        copyToClipboard={copyToClipboard}
                        copied={copied}
                        showRecoveryNudge={showRecoveryNudge}
                        recoveryCode={recoveryCode}
                        dismissRecoveryNudge={dismissRecoveryNudge}
                        showRecoveryImport={showRecoveryImport}
                        setShowRecoveryImport={setShowRecoveryImport}
                        recoveryImportValue={recoveryImportValue}
                        setRecoveryImportValue={setRecoveryImportValue}
                        recoveryError={recoveryError}
                        handleRecoveryImport={handleRecoveryImport}
                    />

                    <VotingSection
                        phase={phase}
                        gaslessEnabled={gaslessEnabled}
                        address={address}
                        identity={identity}
                        optionLabels={optionLabels}
                        selectedVote={selectedVote}
                        setSelectedVote={setSelectedVote}
                        voteStep={voteStep}
                        stepMsg={stepMsg}
                        stepInfo={stepInfo}
                        isProcessing={isProcessing}
                        canVote={canVote}
                        txHash={txHash}
                        error={error}
                        onChainVerified={onChainVerified}
                        joinStatus={joinStatus}
                        handleJoinAndVote={handleJoinAndVote}
                        setVoteStep={setVoteStep}
                        setSelectedVote_reset={() => setSelectedVote(null)}
                        setTxHash={setTxHash}
                        setError={setError}
                    />
                </>
            )}

            {/* ═══ RESULTS TAB ═══ */}
            {tab === "results" && (
                <ResultsTab
                    phase={phase}
                    state={{ voteCount: state.voteCount, selfSignupAllowed: state.selfSignupAllowed }}
                    optionLabels={optionLabels}
                    isAdmin={!!isAdmin}
                    isOnChainCommittee={isOnChainCommittee}
                    isThresholdElection={isThresholdElection}
                    committeeState={committeeState}
                    committeeSharesReady={committeeSharesReady}
                    thresholdMeta={thresholdMeta}
                    hasStoredKey={hasStoredKey}
                    electionKeyHex={typeof window !== "undefined" ? localStorage.getItem(`spectre-election-key-${electionAddress}`) || "" : ""}
                    tallyStep={tallyStep}
                    tallyMsg={tallyMsg}
                    tallyResult={tallyResult}
                    tallyError={tallyError}
                    manualKeyInput={manualKeyInput}
                    setManualKeyInput={setManualKeyInput}
                    selectedMemberIdx={selectedMemberIdx}
                    setSelectedMemberIdx={setSelectedMemberIdx}
                    decryptShareInput={decryptShareInput}
                    setDecryptShareInput={setDecryptShareInput}
                    decryptKeyInput={decryptKeyInput}
                    setDecryptKeyInput={setDecryptKeyInput}
                    decryptedShareResult={decryptedShareResult}
                    decryptShareError={decryptShareError}
                    handleDecryptShare={handleDecryptShare}
                    thresholdShareInputs={thresholdShareInputs}
                    setThresholdShareInputs={setThresholdShareInputs}
                    runTally={runTally}
                    runThresholdTally={runThresholdTally}
                    runOnChainCommitteeTally={runOnChainCommitteeTally}
                    setTallyResult={setTallyResult}
                    setTallyStep={setTallyStep}
                    onChainTally={onChainTally}
                    commitStep={commitStep}
                    commitTxHash={commitTxHash}
                    commitError={commitError}
                    handleCommitTally={handleCommitTally}
                    copyToClipboard={copyToClipboard}
                    copied={copied}
                />
            )}

            {/* ═══ COMMITTEE TAB (Advanced only, stays inline) ═══ */}
            {tab === "committee" && committeeState && (
                <>
                    {/* Committee status header */}
                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>
                            Committee ({committeeState.threshold}-of-{committeeState.members.length})
                        </h4>
                        <div style={{ display: "flex", gap: 16, fontSize: "0.8rem", color: "var(--text-muted)", flexWrap: "wrap" }}>
                            <span>Keys: {committeeState.registeredKeyCount}/{committeeState.members.length}</span>
                            <span>Finalized: {committeeState.finalized ? "Yes" : "No"}</span>
                            <span>Shares submitted: {committeeState.submittedShareCount}/{committeeState.members.length}</span>
                        </div>
                    </div>

                    {/* Member status list */}
                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: 10 }}>Members</h4>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {committeeState.members.map((memberAddr, i) => {
                                const addrLower = memberAddr.toLowerCase()
                                const hasKey = committeeState.memberPubKeys[addrLower]?.length > 2
                                const hasShare = committeeState.memberHasSubmittedShare[addrLower]
                                const isMe = address?.toLowerCase() === addrLower
                                // Look up name from on-chain metadata
                                const metaStored = typeof window !== "undefined" ? JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}") : {}
                                const memberName = metaStored.committee?.find((c: any) => c.address?.toLowerCase() === addrLower)?.name || ""

                                return (
                                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: isMe ? "var(--purple-bg)" : "var(--bg)", borderRadius: 8, border: `1px solid ${isMe ? "var(--purple-border)" : "var(--border)"}` }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                            <span className="mono" style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                                {memberName ? `${memberName} ` : ""}{memberAddr.slice(0, 6)}...{memberAddr.slice(-4)}
                                            </span>
                                            {isMe && <span style={{ fontSize: "0.65rem", color: "var(--purple)", fontWeight: 600 }}>YOU</span>}
                                        </div>
                                        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                                            <span style={{ fontSize: "0.65rem", padding: "2px 6px", borderRadius: 4, background: hasKey ? "var(--success-bg-medium)" : "var(--warning-bg)", color: hasKey ? "var(--success)" : "var(--warning)" }}>
                                                {hasKey ? "Key ✓" : "No key"}
                                            </span>
                                            {phase === "closed" && (
                                                <span style={{ fontSize: "0.65rem", padding: "2px 6px", borderRadius: 4, background: hasShare ? "var(--success-bg-medium)" : "var(--slate-bg)", color: hasShare ? "var(--success)" : "var(--text-muted)" }}>
                                                    {hasShare ? "Share ✓" : "Pending"}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Phase 1: Key registration (during signup, before finalization) */}
                    {phase === "signup" && !committeeState.finalized && isMyCommitteeMember && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--purple-border-strong)" }}>
                            {!myKeyRegistered ? (
                                <>
                                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>Register Your Key</h4>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                        Generate a fresh secp256k1 keypair. Your private key stays in this browser — only the public key goes on-chain.
                                    </p>
                                    <button className="btn-primary" onClick={handleRegisterCommitteeKey} disabled={committeeLoading}>
                                        {committeeLoading ? "Generating & Registering..." : "Generate My Key"}
                                    </button>
                                </>
                            ) : (
                                <>
                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <span style={{ fontSize: "1.2rem", color: "var(--success)" }}>&#10003;</span>
                                        <div style={{ flex: 1 }}>
                                            <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>Key registered!</p>
                                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                                {hasStoredCommitteeKey
                                                    ? "Waiting for admin to finalize."
                                                    : "Registered from another browser."}
                                            </p>
                                        </div>
                                        {!hasStoredCommitteeKey && (
                                            <button
                                                className="btn-secondary"
                                                style={{ padding: "6px 12px", fontSize: "0.75rem", whiteSpace: "nowrap" }}
                                                onClick={() => {
                                                    const key = prompt("Paste your 64-character hex private key:")
                                                    if (key && key.trim().length === 64 && /^[0-9a-fA-F]+$/.test(key.trim()) && committeeKeyStorageKey) {
                                                        localStorage.setItem(committeeKeyStorageKey, key.trim())
                                                        window.location.reload()
                                                    }
                                                }}
                                            >
                                                Import Key
                                            </button>
                                        )}
                                    </div>
                                    {hasStoredCommitteeKey && (
                                        <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Private Key</span>
                                                <button
                                                    className="btn-secondary"
                                                    style={{ padding: "2px 8px", fontSize: "0.7rem" }}
                                                    onClick={() => {
                                                        const k = localStorage.getItem(committeeKeyStorageKey)
                                                        if (k) { navigator.clipboard.writeText(k); setCopied("committee-key"); setTimeout(() => setCopied(""), 2000) }
                                                    }}
                                                >
                                                    {copied === "committee-key" ? "Copied!" : "Copy"}
                                                </button>
                                            </div>
                                            <p className="mono" style={{ fontSize: "0.6rem", color: "var(--text-muted)", wordBreak: "break-all", lineHeight: 1.4 }}>
                                                {localStorage.getItem(committeeKeyStorageKey) || ""}
                                            </p>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {/* Admin: Finalize committee (all keys registered, not yet finalized) */}
                    {phase === "signup" && !committeeState.finalized && isAdmin && committeeState.registeredKeyCount === committeeState.members.length && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>Finalize Committee</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                All {committeeState.members.length} keys registered. Run the dealer ceremony to generate the election key and encrypted shares.
                                The master key is discarded after splitting — only the committee can reconstruct it.
                            </p>
                            <button className="btn-primary" onClick={handleFinalizeCommittee} disabled={committeeLoading}>
                                {committeeLoading ? "Running Dealer Ceremony..." : "Run Dealer & Finalize"}
                            </button>
                        </div>
                    )}

                    {/* Waiting message: finalized but signup still open */}
                    {phase === "signup" && committeeState.finalized && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)", background: "var(--success-bg)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontSize: "1.2rem" }}>&#10003;</span>
                                <div>
                                    <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>Committee finalized!</p>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                        Election key is set. Admin can close signup to open voting.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Phase 3: Submit share (after voting closed) */}
                    {phase === "closed" && isMyCommitteeMember && !myShareSubmitted && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--purple-border-strong)" }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>Decrypt & Submit Your Share</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                Voting is closed. Decrypt your share using the private key stored in this browser and submit it on-chain.
                                {committeeState.submittedShareCount >= committeeState.threshold
                                    ? " Threshold already met — submitting is optional."
                                    : ` Need ${committeeState.threshold - committeeState.submittedShareCount} more share(s) to reach threshold.`}
                            </p>
                            <button className="btn-primary" onClick={handleSubmitDecryptedShare} disabled={committeeLoading}>
                                {committeeLoading ? "Decrypting & Submitting..." : "Decrypt & Submit My Share"}
                            </button>
                        </div>
                    )}

                    {phase === "closed" && isMyCommitteeMember && myShareSubmitted && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)", background: "var(--success-bg)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontSize: "1.2rem" }}>&#10003;</span>
                                <div>
                                    <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>Share submitted!</p>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                        {committeeSharesReady
                                            ? "Threshold reached — results can be tallied on the Results tab."
                                            : `${committeeState.submittedShareCount} of ${committeeState.threshold} shares submitted. Waiting for more committee members.`}
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Threshold status */}
                    {phase === "closed" && committeeSharesReady && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)", background: "var(--accent-bg)" }}>
                            <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--accent)", textAlign: "center" }}>
                                Threshold met ({committeeState.submittedShareCount} ≥ {committeeState.threshold}) — go to Results tab to tally!
                            </p>
                        </div>
                    )}

                    {/* Error / success messages */}
                    {committeeMsg && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)" }}>
                            <p style={{ fontSize: "0.85rem", color: "var(--success)" }}>{committeeMsg}</p>
                        </div>
                    )}
                    {committeeError && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--error)" }}>
                            <p style={{ fontSize: "0.85rem", color: "var(--error)" }}>{committeeError}</p>
                        </div>
                    )}
                </>
            )}

            {/* ═══ MANAGE TAB ═══ */}
            {tab === "manage" && (
                <ManageTab
                    phase={phase}
                    isAdmin={!!isAdmin}
                    electionAddress={electionAddress}
                    shareUrl={shareUrl}
                    isInviteCodeElection={isInviteCodeElection}
                    isAllowlistElection={isAllowlistElection}
                    inviteCodeMeta={inviteCodeMeta}
                    allowlistMeta={allowlistMeta}
                    commitment={commitment}
                    setCommitment={setCommitment}
                    bulkCommitments={bulkCommitments}
                    setBulkCommitments={setBulkCommitments}
                    adminLoading={adminLoading}
                    adminMsg={adminMsg}
                    registerVoter={registerVoter}
                    registerBulk={registerBulk}
                    handleCloseSignup={handleCloseSignup}
                    handleCloseVoting={handleCloseVoting}
                    copyToClipboard={copyToClipboard}
                    copied={copied}
                    setCopied={setCopied}
                />
            )}

            {/* Info footer */}
            {isAdvanced && (
                <div style={{ marginTop: 24, padding: "12px 0", borderTop: "1px solid var(--border)", textAlign: "center" }}>
                    <a href={`${EXPLORER_URL}/address/${electionAddress}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                        Contract: {electionAddress.slice(0, 10)}...{electionAddress.slice(-8)}
                    </a>
                </div>
            )}
        </>
    )
}
