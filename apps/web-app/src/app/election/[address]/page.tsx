"use client"

import { useSpectre } from "@/context/SpectreContext"
import { useState, useEffect, useCallback, useMemo } from "react"
import { Contract, JsonRpcProvider, toUtf8String, keccak256, toUtf8Bytes, ZeroHash, ZeroAddress, hexlify } from "ethers"
import { Identity, Group } from "@semaphore-protocol/core"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { generateProofInBrowser } from "@/lib/proof"
import { generateAnonJoinProof } from "@/lib/anonJoinProof"
import { sealBallot, encodeVotePayload, unsealTime } from "@/lib/ballot"
import { countBallots, tallyCommitment, type TallyResult, type BallotRecord } from "@/lib/tally"
import { tokenGateMessage, isRelayGate } from "@/lib/gate"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, SEMAPHORE_ABI, RPC_URL, EXPLORER_URL, MAX_LOG_RANGE, FACTORY_DEPLOY_BLOCK, FACTORY_CONFIGURED, SUPPORTED_ELECTION_VERSION } from "@/lib/contracts"
import { friendlyError } from "@/lib/errors"
import { relaySignUp, relayAnonJoin, relayCastVote, waitForRelayTx, verifyVoteOnChain, verifyJoinOnChain, verifySignupOnChain, randomTimingDelay, RelayError } from "@/lib/relayer"
import { validateCode, validateIdentifier } from "@/lib/inviteCodes"
import { poseidon2 } from "poseidon-lite"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import ElectionHeader from "@/components/election/ElectionHeader"
import SignupSection from "@/components/election/SignupSection"
import VotingSection from "@/components/election/VotingSection"
import ResultsTab from "@/components/election/ResultsTab"
import ManageTab from "@/components/election/ManageTab"

type Tab = "vote" | "results" | "manage"
type Phase = "signup" | "voting" | "closed"
type VoteStep = "idle" | "fetching-signup-group" | "generating-join-proof" | "submitting-join" | "fetching-voting-group" | "generating-vote-proof" | "encrypting" | "submitting-vote" | "timing-delay" | "verifying" | "done" | "error"
type TallyStep = "idle" | "fetching" | "decrypting" | "done" | "error"

interface ElectionState {
    version: bigint
    proposalId: string
    signupOpen: boolean
    votingOpen: boolean
    voteCount: number
    signupGroupId: string
    votingGroupId: string
    admin: string
    registrar: string
    signupDeadline: number
    votingDeadline: number
    numOptions: number
    selfSignupAllowed: boolean
}

interface ElectionMeta {
    title: string
    labels: string[]
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
    if (!FACTORY_CONFIGURED) return null
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

    // ── Per-election identity (scoped to election + wallet/anonymous session) ──
    const [identity, setIdentity] = useState<Identity | null>(null)
    const [voterWeight, setVoterWeight] = useState<bigint>(1n) // voting weight (default 1 for non-weighted)

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

    // Weight storage key (same scoping as identity)
    const weightStorageKey = useMemo(() => {
        const scope = address ? address.toLowerCase() : anonymousId ? `anon-${anonymousId}` : ""
        return scope ? `spectre-weight-${electionAddress}-${scope}` : ""
    }, [electionAddress, address, anonymousId])

    // Vote version storage key (same scoping as identity)
    const versionStorageKey = useMemo(() => {
        const scope = address ? address.toLowerCase() : anonymousId ? `anon-${anonymousId}` : ""
        return scope ? `spectre-vote-version-${electionAddress}-${scope}` : ""
    }, [electionAddress, address, anonymousId])

    // Load vote version from localStorage on mount
    useEffect(() => {
        if (!versionStorageKey) return
        const saved = localStorage.getItem(versionStorageKey)
        if (saved) {
            const v = parseInt(saved, 10)
            setVoteVersion(v)
            if (v > 0) setHasVotedBefore(true)
        }
    }, [versionStorageKey])

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

    // Load voter weight from localStorage
    useEffect(() => {
        if (!weightStorageKey) return
        const saved = localStorage.getItem(weightStorageKey)
        if (saved) setVoterWeight(BigInt(saved))
        else setVoterWeight(1n) // default weight for non-weighted elections
    }, [weightStorageKey])

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


    // Vote state
    const [selectedVote, setSelectedVote] = useState<number | null>(null)
    const [voteStep, setVoteStep] = useState<VoteStep>("idle")
    const [stepMsg, setStepMsg] = useState("")
    const [txHash, setTxHash] = useState("")
    const [error, setError] = useState("")

    // Gasless relay state (cont.)
    const [onChainVerified, setOnChainVerified] = useState<boolean | null>(null) // null = not checked, true/false = result

    // Vote overwriting state
    const [voteVersion, setVoteVersion] = useState(0)
    const [hasVotedBefore, setHasVotedBefore] = useState(false)
    const MAX_OVERWRITES = 5

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

    // Tally state (public recount after the deadline)
    const [tallyStep, setTallyStep] = useState<TallyStep>("idle")
    const [tallyMsg, setTallyMsg] = useState("")
    const [tallyResult, setTallyResult] = useState<TallyResult | null>(null)
    const [tallyError, setTallyError] = useState("")
    const [closingVoting, setClosingVoting] = useState(false)
    const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

    // Tick once a second so deadline-dependent UI (sealed ballots, close voting) updates on its own
    useEffect(() => {
        const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
        return () => clearInterval(timer)
    }, [])

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
                // Invite-code, allowlist, and email-domain elections force gasless
                if (onChain.gateType === "invite-codes") setGaslessEnabled(true)
                if (onChain.gateType === "allowlist") setGaslessEnabled(true)
                if (onChain.gateType === "email-domain") setGaslessEnabled(true)
                if (onChain.gateType === "github-org") setGaslessEnabled(true)
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

    // Gate type from on-chain metadata (cached in localStorage)
    const gateType = useMemo(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
            return typeof stored.gateType === "string" ? stored.gateType as string : ""
        } catch { return "" }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress, metaLoaded])

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

    // Token gate metadata detection
    const tokenGateMeta = useMemo(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
            if (stored.gateType === "token-gate" && stored.tokenGate) {
                return stored.tokenGate as {
                    tokenAddress: string
                    tokenType: "erc20" | "erc721"
                    minBalance: string
                    tokenSymbol: string
                    tokenDecimals: number
                }
            }
        } catch { /* ignore */ }
        return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress, metaLoaded])

    const isTokenGateElection = tokenGateMeta !== null

    // Email domain metadata detection
    const emailDomainMeta = useMemo(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
            if (stored.gateType === "email-domain" && stored.emailDomain?.domains) {
                return { domains: stored.emailDomain.domains as string[] }
            }
        } catch { /* ignore */ }
        return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress, metaLoaded])

    const isEmailDomainElection = emailDomainMeta !== null

    // GitHub org metadata detection
    const githubOrgMeta = useMemo(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(`spectre-election-meta-${electionAddress}`) || "{}")
            if (stored.gateType === "github-org" && stored.githubOrg?.org) {
                return { org: stored.githubOrg.org as string }
            }
        } catch { /* ignore */ }
        return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [electionAddress, metaLoaded])

    const isGithubOrgElection = githubOrgMeta !== null

    // GitHub OAuth state (read from URL params after OAuth callback redirect)
    const [ghUser, setGhUser] = useState("")
    const [ghToken, setGhToken] = useState("")
    const [ghId, setGhId] = useState("")
    const [ghError, setGhError] = useState("")

    // Read GitHub OAuth params from URL on mount
    useEffect(() => {
        const token = searchParams.get("ghToken")
        const user = searchParams.get("ghUser")
        const id = searchParams.get("ghId")
        const error = searchParams.get("ghError")
        if (token && user && id) {
            setGhToken(token)
            setGhUser(user)
            setGhId(id)
        }
        if (error) {
            setGhError(error === "not-a-member"
                ? `You're not a member of the required GitHub organization`
                : error)
        }
        // Clean URL params after reading
        if (token || error) {
            const url = new URL(window.location.href)
            url.searchParams.delete("ghToken")
            url.searchParams.delete("ghUser")
            url.searchParams.delete("ghId")
            url.searchParams.delete("ghError")
            window.history.replaceState({}, "", url.toString())
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Email verification state
    const [voterEmail, setVoterEmail] = useState("")
    const [emailDomainMatch, setEmailDomainMatch] = useState(false)
    const [emailSending, setEmailSending] = useState(false)
    const [emailCodeSent, setEmailCodeSent] = useState(false)
    const [emailCode, setEmailCode] = useState("")
    const [emailVerifying, setEmailVerifying] = useState(false)
    const [emailVerified, setEmailVerified] = useState(false)
    const [emailToken, setEmailToken] = useState("")
    const [emailError, setEmailError] = useState("")

    // Email domain validation (client-side instant check)
    useEffect(() => {
        if (!emailDomainMeta || !voterEmail.trim()) {
            setEmailDomainMatch(false)
            return
        }
        const domain = voterEmail.toLowerCase().trim().split("@")[1]
        if (!domain) { setEmailDomainMatch(false); return }
        const allowed = emailDomainMeta.domains.map((d: string) => d.toLowerCase().trim())
        setEmailDomainMatch(allowed.includes(domain))
    }, [voterEmail, emailDomainMeta])

    // Send verification code
    const handleEmailSendCode = useCallback(async () => {
        if (!voterEmail.trim() || !emailDomainMatch) return
        setEmailSending(true)
        setEmailError("")
        try {
            const res = await fetch("/api/verify-email", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "send", email: voterEmail.trim(), electionAddress }),
            })
            const data = await res.json()
            if (!data.success) throw new Error(data.error || "Failed to send code")
            setEmailCodeSent(true)
            addLog("Verification code sent to your email")
        } catch (err: any) {
            setEmailError(err.message)
        } finally { setEmailSending(false) }
    }, [voterEmail, emailDomainMatch, electionAddress, addLog])

    // Verify code
    const handleEmailVerifyCode = useCallback(async () => {
        if (!emailCode.trim()) return
        setEmailVerifying(true)
        setEmailError("")
        try {
            const res = await fetch("/api/verify-email", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "verify", email: voterEmail.trim(), code: emailCode.trim(), electionAddress }),
            })
            const data = await res.json()
            if (!data.success) throw new Error(data.error || "Verification failed")
            setEmailVerified(true)
            setEmailToken(data.token)
            addLog("Email verified!")
        } catch (err: any) {
            setEmailError(err.message)
        } finally { setEmailVerifying(false) }
    }, [emailCode, voterEmail, electionAddress, addLog])

    // Token balance check
    const [tokenBalance, setTokenBalance] = useState<string | null>(null)
    const [tokenEligible, setTokenEligible] = useState(false)
    const [tokenChecking, setTokenChecking] = useState(false)

    useEffect(() => {
        if (!isTokenGateElection || !tokenGateMeta || !address) {
            setTokenBalance(null)
            setTokenEligible(false)
            return
        }
        let cancelled = false
        setTokenChecking(true)
        ;(async () => {
            try {
                const provider = new JsonRpcProvider(RPC_URL)
                const erc20Abi = ["function balanceOf(address) view returns (uint256)"]
                const tokenContract = new Contract(tokenGateMeta.tokenAddress, erc20Abi, provider)
                const rawBalance = await tokenContract.balanceOf(address)
                if (cancelled) return

                if (tokenGateMeta.tokenType === "erc721") {
                    const bal = Number(rawBalance)
                    setTokenBalance(String(bal))
                    setTokenEligible(bal > 0)
                } else {
                    const decimals = tokenGateMeta.tokenDecimals || 18
                    const formatted = Number(rawBalance) / (10 ** decimals)
                    setTokenBalance(formatted.toString())
                    const minRequired = Number(tokenGateMeta.minBalance || "1")
                    setTokenEligible(formatted >= minRequired)
                }
            } catch {
                if (!cancelled) { setTokenBalance(null); setTokenEligible(false) }
            } finally {
                if (!cancelled) setTokenChecking(false)
            }
        })()
        return () => { cancelled = true }
    }, [isTokenGateElection, tokenGateMeta, address])

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
    const [unsupported, setUnsupported] = useState(false)
    const refresh = useCallback(async () => {
        if (!FACTORY_CONFIGURED) { setLoading(false); return }
        try {
            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)

            // Older Spectre contracts have no VERSION(); this frontend can't run them safely.
            const version: bigint = await c.VERSION().catch(() => 0n)
            if (version !== SUPPORTED_ELECTION_VERSION) {
                setUnsupported(true)
                return
            }

            const [pid, sOpen, vOpen, vc, sgid, vgid, admin, registrar, sdl, vdl, numOpt, selfSignup] = await Promise.all([
                c.proposalId(), c.signupOpen(), c.votingOpen(), c.voteCount(),
                c.signupGroupId(), c.votingGroupId(),
                c.admin(), c.registrar(),
                c.signupDeadline(), c.votingDeadline(), c.numOptions(),
                c.selfSignupAllowed(),
            ])
            setState({
                version,
                proposalId: pid.toString(),
                signupOpen: sOpen,
                votingOpen: vOpen,
                voteCount: Number(vc),
                signupGroupId: sgid.toString(),
                votingGroupId: vgid.toString(),
                admin,
                registrar,
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
                setOnChainTally(null)
            }
        } catch (err: any) {
            addLog("Failed to load election. Check your connection and try refreshing.")
        } finally { setLoading(false) }
    }, [electionAddress, addLog])

    useEffect(() => { refresh() }, [refresh])

    // ── CHECK SIGNUP STATUS ──
    const checkSignup = useCallback(async () => {
        if (!identity || !state) return
        setSignupStatus("checking")
        try {
            const members = await fetchGroupMembers(BigInt(state.signupGroupId))
            const weightedLeaf = poseidon2([identity.commitment, voterWeight])
            const found = members.some(m => m.toString() === weightedLeaf.toString())
            setSignupStatus(found ? "signed-up" : "not-signed-up")
        } catch (err: any) {
            addLog("Could not check signup status. Try refreshing the page.")
            setSignupStatus("unknown")
        }
    }, [identity, state, addLog, voterWeight])

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
            const weightedLeaf = poseidon2([votingId.commitment, voterWeight])
            const found = members.some(m => m.toString() === weightedLeaf.toString())
            setJoinStatus(found ? "joined" : "not-joined")
        } catch {
            setJoinStatus("unknown")
        }
    }, [state, getVotingIdentity, voterWeight])

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
        // Token gate validation check
        if (isTokenGateElection && !tokenEligible) {
            addLog("Insufficient token balance to sign up")
            return
        }
        // Email domain validation check
        if (isEmailDomainElection && !emailVerified) {
            addLog("Email verification required to sign up")
            return
        }
        // GitHub org validation check
        if (isGithubOrgElection && !ghToken) {
            addLog("GitHub authentication required to sign up")
            return
        }
        // Gated elections and gasless open elections sign up through the relay.
        // For gated elections the relay checks eligibility and registers the voter
        // as the election's registrar; the contract rejects self-signup.
        if (gaslessEnabled || isRelayGate(gateType)) {
            setSignupLoading(true)
            try {
                let walletSignature: string | undefined
                if (isTokenGateElection) {
                    if (!signer || !address) throw new Error("Connect the wallet that holds the tokens")
                    addLog("Sign the message in your wallet to prove you hold the tokens...")
                    walletSignature = await signer.signMessage(
                        tokenGateMessage(electionAddress, identity.commitment.toString(), address)
                    )
                }
                addLog("Relaying signup...")
                const result = await relaySignUp(electionAddress, identity.commitment, {
                    code: isInviteCodeElection ? inviteCode.toLowerCase().trim() : undefined,
                    identifier: isAllowlistElection ? allowlistId.trim() : undefined,
                    voterAddress: isTokenGateElection && address ? address : undefined,
                    walletSignature,
                    email: isEmailDomainElection ? voterEmail.trim() : undefined,
                    emailToken: isEmailDomainElection ? emailToken : undefined,
                    githubToken: isGithubOrgElection ? ghToken : undefined,
                    githubId: isGithubOrgElection ? ghId : undefined,
                })
                addLog(`Signup relayed — tx: ${result.txHash.slice(0, 10)}...`)
                await waitForRelayTx(result.txHash)
                // Store weight from relay response
                const assignedWeight = result.weight
                setVoterWeight(assignedWeight)
                if (weightStorageKey) localStorage.setItem(weightStorageKey, assignedWeight.toString())
                const verified = await verifySignupOnChain(electionAddress, identity.commitment.toString(), result.txHash)
                if (!verified) addLog("Warning: signup event not found on-chain")
                addLog(assignedWeight > 1n ? `Signed up with weight ${assignedWeight}!` : "Signed up for election!")
                setSignupStatus("signed-up")
                await refresh()
            } catch (err: any) {
                addLog(`Signup failed: ${err instanceof RelayError ? err.message : friendlyError(err)}`)
            } finally { setSignupLoading(false) }
            return
        }
        // Open election in wallet mode: the signup is sent from the voter's wallet, so it is
        // public who signed up. Joining and voting are always relayed, so the ballot isn't linked.
        if (!signer) return
        setSignupLoading(true)
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.signUp(identity.commitment)
            await tx.wait()
            setVoterWeight(1n)
            if (weightStorageKey) localStorage.setItem(weightStorageKey, "1")
            addLog("Signed up for election!")
            setSignupStatus("signed-up")
            await refresh()
        } catch (err: any) {
            addLog(`Signup failed: ${friendlyError(err)}`)
        } finally { setSignupLoading(false) }
    }, [identity, signer, state, electionAddress, addLog, refresh, gaslessEnabled, gateType, isInviteCodeElection, codeValid, inviteCode, isAllowlistElection, idValid, allowlistId, isTokenGateElection, tokenEligible, address, isEmailDomainElection, emailVerified, voterEmail, emailToken, isGithubOrgElection, ghToken, ghId, weightStorageKey])

    // ── ANONYMOUS JOIN + VOTE (Phase 2) ──
    // Joins and ballots always go through the relay, in every election mode. Sending them
    // from the voter's wallet would link the wallet to the ballot on-chain.
    const handleJoinAndVote = useCallback(async () => {
        if (!identity || selectedVote === null || !state) return
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

                const weightedSignupLeaf = poseidon2([identity.commitment, voterWeight])
                if (signupGroup.indexOf(weightedSignupLeaf) === -1) {
                    throw new Error("You're not registered for this election. You need to sign up during the registration phase.")
                }

                setVoteStep("generating-join-proof"); setStepMsg("Generating anonymous join proof (10-30s)...")
                addLog("Generating anonymous proof...")
                const joinProof = await generateAnonJoinProof(identity, votingId, signupGroup, BigInt(state.proposalId), voterWeight)
                addLog("Proof ready")

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

            const weightedVotingLeaf = poseidon2([votingId!.commitment, voterWeight])
            if (votingGroup.indexOf(weightedVotingLeaf) === -1) {
                throw new Error("Your anonymous registration hasn't been confirmed yet. Try refreshing the page.")
            }

            setVoteStep("generating-vote-proof"); setStepMsg("Generating vote proof (10-30s)...")
            addLog("Generating vote proof...")

            const rnd = randomBytes(31)
            let voteRand = 0n
            for (const b of rnd) voteRand = (voteRand << 8n) | BigInt(b)

            const proof = await generateProofInBrowser(
                votingId!, votingGroup, BigInt(state.proposalId),
                BigInt(selectedVote), voteRand, BigInt(state.numOptions), voterWeight, BigInt(voteVersion)
            )
            addLog("Proof ready")

            // Seal the ballot to the drand round right after the voting deadline.
            // Nobody holds a key; nobody can open it before then, including the organizer.
            setVoteStep("encrypting"); setStepMsg("Sealing your ballot until the deadline...")
            const payload = encodeVotePayload(BigInt(selectedVote), voterWeight, voteRand)
            const blob = await sealBallot(payload, state.votingDeadline)

            setVoteStep("submitting-vote"); setStepMsg("Relaying sealed ballot...")
            const voteTxHash = await relayCastVote(electionAddress, proof, hexlify(blob))
            setStepMsg("Waiting for vote confirmation...")
            await waitForRelayTx(voteTxHash)
            addLog("Vote submitted successfully")

            // Anti-censorship: independently verify on-chain
            setVoteStep("verifying"); setStepMsg("Verifying vote on-chain...")
            const verified = await verifyVoteOnChain(electionAddress, proof.baseNullifier, voteTxHash)
            setOnChainVerified(verified)
            if (verified) {
                addLog("Vote verified on-chain!")
            } else {
                addLog("Warning: vote not verified on-chain. Try refreshing later to check.")
            }

            setTxHash(voteTxHash); setVoteStep("done"); setStepMsg("")
            // Increment vote version after successful submission
            const newVersion = voteVersion + 1
            setVoteVersion(newVersion)
            setHasVotedBefore(true)
            if (versionStorageKey) {
                localStorage.setItem(versionStorageKey, newVersion.toString())
            }

            await refresh()
        } catch (err: any) {
            const msg = err instanceof RelayError ? err.message : friendlyError(err)
            setError(msg); setVoteStep("error"); setStepMsg("")
            addLog(`Error: ${msg}`)
        }
    }, [identity, selectedVote, state, electionAddress, addLog, refresh, joinStatus, getVotingIdentity, createVotingIdentity, voterWeight, voteVersion, versionStorageKey])

    // ── ADMIN LOGIC ──
    const registerVoter = useCallback(async () => {
        if (!signer || !commitment.trim()) return
        setAdminLoading(true); setAdminMsg("")
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            // Admin registrations: weight 1, no gate key
            const tx = await c.registerVoter(commitment.trim(), 1, ZeroHash)
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

    // Anyone can close voting once the deadline has passed; nobody can close it earlier.
    const handleCloseVoting = useCallback(async () => {
        if (!signer) return
        setClosingVoting(true); setAdminLoading(true); setAdminMsg("")
        try {
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, signer)
            const tx = await c.closeVoting()
            await tx.wait()
            setAdminMsg("Voting closed!"); addLog("Voting closed"); await refresh()
        } catch (err: any) {
            setAdminMsg(`Error: ${friendlyError(err)}`); addLog(`Close voting failed: ${friendlyError(err)}`)
        }
        finally { setClosingVoting(false); setAdminLoading(false) }
    }, [signer, electionAddress, refresh, addLog])

    // ── PUBLIC RECOUNT ──
    // Anyone can open the time-locked ballots after the deadline and count them.
    const runTally = useCallback(async () => {
        if (!state) return
        setTallyError(""); setTallyResult(null)
        try {
            setTallyStep("fetching"); setTallyMsg("Fetching ballots from chain...")
            const provider = new JsonRpcProvider(RPC_URL)
            const c = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
            const currentBlock = await provider.getBlockNumber()
            // Paginate for Base 10k block limit; results stay in chain order
            const events: any[] = []
            for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += MAX_LOG_RANGE) {
                const to = Math.min(from + MAX_LOG_RANGE - 1, currentBlock)
                const chunk = await c.queryFilter(c.filters.VoteCast(), from, to)
                events.push(...chunk)
            }
            const records: BallotRecord[] = events.map((event: any) => ({
                baseNullifier: event.args.baseNullifier.toString(),
                voteCommitment: event.args.voteCommitment.toString(),
                encryptedBlob: event.args.encryptedBlob,
            }))

            setTallyStep("decrypting"); setTallyMsg(`Opening ${records.length} ballot(s) with the drand beacon...`)
            const result = await countBallots(records, state.numOptions, state.votingDeadline)
            setTallyResult(result)
            setTallyStep("done"); setTallyMsg("")

            const summary = result.optionCounts.map((count: number, i: number) => `${optionLabels[i] || `Option ${i}`}: ${count}`).join(", ")
            addLog(`Count: ${summary}`)
        } catch (err: any) {
            setTallyError(err.message || "Count failed. Please try again."); setTallyStep("error"); setTallyMsg("")
        }
    }, [electionAddress, addLog, state, optionLabels])

    const resetTally = useCallback(() => { setTallyResult(null); setTallyStep("idle") }, [])

    // ── COMMIT TALLY ON-CHAIN ──
    const handleCommitTally = useCallback(async () => {
        if (!signer || !tallyResult || !state) return
        setCommitError(""); setCommitTxHash("")
        setCommitStep("submitting")

        try {
            const hash = tallyCommitment(tallyResult.optionCounts, tallyResult.totalValid, tallyResult.totalInvalid)
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
            addLog("Results published on-chain")
            await refresh()
        } catch (err: any) {
            setCommitError(friendlyError(err))
            setCommitStep("error")
        }
    }, [signer, tallyResult, state, electionAddress, addLog, refresh])

    // ── SHARE (clean URL — metadata is on-chain) ──
    const shareUrl = useMemo(() => {
        const base = typeof window !== "undefined" ? window.location.origin : ""
        return `${base}/election/${electionAddress}`
    }, [electionAddress])

    // Derived
    const isAdmin = address && state?.admin && address.toLowerCase() === state.admin.toLowerCase()
    const isProcessing = !["idle", "done", "error"].includes(voteStep)
    const deadlinePassed = !!state && state.votingDeadline > 0 && nowSec > state.votingDeadline
    const unsealAt = useMemo(() => {
        if (!state || state.votingDeadline <= 0) return 0
        try { return unsealTime(state.votingDeadline) } catch { return 0 }
    }, [state])

    const stepInfo = useMemo(() => {
        if (!isProcessing) return null
        const steps: Record<string, { step: number; total: number; label: string }> = {
            "fetching-signup-group":  { step: 1, total: 6, label: "Preparing..." },
            "generating-join-proof":  { step: 2, total: 6, label: "Proving your eligibility (~15s)" },
            "submitting-join":        { step: 3, total: 6, label: "Submitting anonymous registration" },
            "timing-delay":           { step: 3, total: 6, label: "Securing your anonymity..." },
            "fetching-voting-group":  { step: 4, total: 6, label: "Preparing your ballot..." },
            "generating-vote-proof":  { step: 5, total: 6, label: "Proving your vote (~15s)" },
            "encrypting":             { step: 5, total: 6, label: "Sealing your ballot until the deadline" },
            "submitting-vote":        { step: 6, total: 6, label: "Submitting your sealed ballot" },
            "verifying":              { step: 6, total: 6, label: "Confirming on-chain..." },
        }
        return steps[voteStep] || null
    }, [voteStep, isProcessing])
    // Voting needs a deadline to seal ballots to; every v9 election has one.
    const canVote = !!state && state.votingDeadline > 0 && !deadlinePassed
    // Gated elections: voters sign up on this page and the relay registers them as registrar.
    const relayGated = !!state && !state.selfSignupAllowed && isRelayGate(gateType) && state.registrar !== ZeroAddress
    // Metadata claims a gate but the contract allows open signup: the gate isn't enforced.
    const gateNotEnforced = !!state && state.selfSignupAllowed && isRelayGate(gateType)

    // Phase badge color
    const phaseBadge = phase === "signup" ? { text: "SIGNUP", cls: "status-open" }
        : phase === "voting" ? { text: deadlinePassed ? "VOTING ENDED" : "VOTING", cls: deadlinePassed ? "status-closed" : "status-open" }
        : { text: "CLOSED", cls: "status-closed" }

    if (!FACTORY_CONFIGURED) return (
        <div className="card" style={{ textAlign: "center" }}>
            <p style={{ fontWeight: 600, marginBottom: 6 }}>This deployment isn&apos;t configured yet</p>
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                The contracts this version of Spectre needs haven&apos;t been deployed.
            </p>
            <Link href="/" style={{ display: "inline-block", marginTop: 12 }}>Back to elections</Link>
        </div>
    )

    if (loading) return (
        <div style={{ textAlign: "center", padding: 48 }}>
            <div className="spinner" style={{ margin: "0 auto 12px" }} />
            <p style={{ color: "var(--text-muted)" }}>Loading election...</p>
        </div>
    )

    if (unsupported) return (
        <div className="card" style={{ textAlign: "center" }}>
            <p style={{ fontWeight: 600, marginBottom: 6 }}>This election uses an older version of Spectre</p>
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                It was created with contracts that had known privacy problems, and this app can&apos;t run it.
            </p>
            <Link href="/" style={{ display: "inline-block", marginTop: 12 }}>Back to elections</Link>
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
                isTokenGateElection={isTokenGateElection}
                tokenGateMeta={tokenGateMeta ? { tokenSymbol: tokenGateMeta.tokenSymbol, tokenType: tokenGateMeta.tokenType } : null}
                inviteCodeCount={inviteCodeMeta?.totalCodes ?? null}
                allowlistEntryCount={allowlistMeta?.totalEntries ?? null}
                signupDeadline={state.signupDeadline}
                votingDeadline={state.votingDeadline}
                unsealAt={unsealAt}
                shareUrl={shareUrl}
                isAdmin={!!isAdmin}
                tab={tab}
                setTab={setTab}
                isEmailDomainElection={isEmailDomainElection}
                emailDomainMeta={emailDomainMeta}
                isGithubOrgElection={isGithubOrgElection}
                githubOrgMeta={githubOrgMeta}
                copyToClipboard={copyToClipboard}
                copied={copied}
            />

            {gateNotEnforced && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--warning)" }}>
                    <p style={{ fontSize: "0.85rem", color: "var(--warning)", lineHeight: 1.5 }}>
                        This election lists a signup requirement, but its contract lets anyone sign up directly,
                        so the requirement isn&apos;t enforced. Treat it as an open election.
                    </p>
                </div>
            )}

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
                        selfSignupAllowed={state.selfSignupAllowed || relayGated}
                        isInviteCodeElection={isInviteCodeElection}
                        isAllowlistElection={isAllowlistElection}
                        isTokenGateElection={isTokenGateElection}
                        tokenGateMeta={tokenGateMeta}
                        tokenBalance={tokenBalance}
                        tokenEligible={tokenEligible}
                        tokenChecking={tokenChecking}
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
                        isEmailDomainElection={isEmailDomainElection}
                        emailDomainMeta={emailDomainMeta}
                        voterEmail={voterEmail}
                        setVoterEmail={setVoterEmail}
                        emailDomainMatch={emailDomainMatch}
                        emailSending={emailSending}
                        emailCodeSent={emailCodeSent}
                        emailCode={emailCode}
                        setEmailCode={setEmailCode}
                        emailVerifying={emailVerifying}
                        emailVerified={emailVerified}
                        emailError={emailError}
                        handleEmailSendCode={handleEmailSendCode}
                        handleEmailVerifyCode={handleEmailVerifyCode}
                        isGithubOrgElection={isGithubOrgElection}
                        githubOrgMeta={githubOrgMeta}
                        ghUser={ghUser}
                        ghToken={ghToken}
                        ghError={ghError}
                        electionAddress={electionAddress}
                    />

                    <VotingSection
                        phase={phase}
                        address={address}
                        identity={identity}
                        gaslessEnabled={gaslessEnabled}
                        optionLabels={optionLabels}
                        selectedVote={selectedVote}
                        setSelectedVote={setSelectedVote}
                        voteStep={voteStep}
                        stepMsg={stepMsg}
                        stepInfo={stepInfo}
                        isProcessing={isProcessing}
                        canVote={canVote}
                        deadlinePassed={deadlinePassed}
                        unsealAt={unsealAt}
                        txHash={txHash}
                        error={error}
                        onChainVerified={onChainVerified}
                        joinStatus={joinStatus}
                        handleJoinAndVote={handleJoinAndVote}
                        setVoteStep={setVoteStep}
                        setSelectedVote_reset={() => setSelectedVote(null)}
                        setTxHash={setTxHash}
                        setError={setError}
                        hasVotedBefore={hasVotedBefore}
                        voteVersion={voteVersion}
                        maxOverwrites={MAX_OVERWRITES}
                    />
                </>
            )}

            {/* ═══ RESULTS TAB ═══ */}
            {tab === "results" && (
                <ResultsTab
                    phase={phase}
                    voteCount={state.voteCount}
                    optionLabels={optionLabels}
                    isAdmin={!!isAdmin}
                    unsealAt={unsealAt}
                    nowSec={nowSec}
                    tallyStep={tallyStep}
                    tallyMsg={tallyMsg}
                    tallyResult={tallyResult}
                    tallyError={tallyError}
                    runTally={runTally}
                    resetTally={resetTally}
                    onChainTally={onChainTally}
                    commitStep={commitStep}
                    commitTxHash={commitTxHash}
                    commitError={commitError}
                    handleCommitTally={handleCommitTally}
                    canCloseVoting={phase === "voting" && deadlinePassed}
                    closingVoting={closingVoting}
                    handleCloseVoting={handleCloseVoting}
                    walletConnected={!!signer}
                />
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
                    deadlinePassed={deadlinePassed}
                    votingDeadline={state.votingDeadline}
                    copyToClipboard={copyToClipboard}
                    copied={copied}
                    setCopied={setCopied}
                />
            )}

            {/* Info footer */}
            <div style={{ marginTop: 24, padding: "12px 0", borderTop: "1px solid var(--border)", textAlign: "center" }}>
                <a href={`${EXPLORER_URL}/address/${electionAddress}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                    Contract: {electionAddress.slice(0, 10)}...{electionAddress.slice(-8)}
                </a>
            </div>
        </>
    )
}
