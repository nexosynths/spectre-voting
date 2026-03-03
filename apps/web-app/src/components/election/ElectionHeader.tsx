"use client"

import Link from "next/link"

type Tab = "vote" | "results" | "manage" | "committee"
type Phase = "signup" | "voting" | "closed"

interface ElectionHeaderProps {
    displayTitle: string
    phase: Phase
    phaseBadge: { text: string; cls: string }
    voteCount: number
    numOptions: number
    selfSignupAllowed: boolean
    gaslessEnabled: boolean
    isInviteCodeElection: boolean
    isAllowlistElection: boolean
    isTokenGateElection: boolean
    tokenGateMeta: { tokenSymbol: string; tokenType: string } | null
    inviteCodeCount: number | null
    allowlistEntryCount: number | null
    isEmailDomainElection: boolean
    emailDomainMeta: { domains: string[] } | null
    isGithubOrgElection: boolean
    githubOrgMeta: { org: string } | null
    isThresholdElection: boolean
    thresholdMeta: { threshold: number; totalShares: number } | null
    signupDeadline: number
    votingDeadline: number
    shareUrl: string
    isOnChainCommittee: boolean
    isAdmin: boolean
    tab: Tab
    setTab: (t: Tab) => void
    copyToClipboard: (text: string, label: string) => void
    copied: string
}

export default function ElectionHeader({
    displayTitle, phase, phaseBadge, voteCount, numOptions,
    selfSignupAllowed, gaslessEnabled, isInviteCodeElection, isAllowlistElection,
    isTokenGateElection, tokenGateMeta,
    isEmailDomainElection, emailDomainMeta,
    isGithubOrgElection, githubOrgMeta,
    inviteCodeCount, allowlistEntryCount, isThresholdElection, thresholdMeta,
    signupDeadline, votingDeadline, shareUrl, isOnChainCommittee, isAdmin,
    tab, setTab, copyToClipboard, copied,
}: ElectionHeaderProps) {
    const gateLabel = isGithubOrgElection ? `GitHub Org (${githubOrgMeta?.org || "?"})` : isEmailDomainElection ? `Email domain (${emailDomainMeta?.domains.map(d => "@" + d).join(", ") || "?"})` : isTokenGateElection ? `Token gate (${tokenGateMeta?.tokenSymbol || tokenGateMeta?.tokenType?.toUpperCase() || "?"})` : isAllowlistElection ? `Allowlist (${allowlistEntryCount || "?"})` : isInviteCodeElection ? `Invite codes (${inviteCodeCount || "?"})` : selfSignupAllowed ? "Open signup" : "Admin only"

    return (
        <>
            <div style={{ marginBottom: 12, fontSize: "0.8rem" }}>
                <Link href="/">← All Elections</Link>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <h2 style={{ fontSize: "1.1rem", fontWeight: 700, lineHeight: 1.3, flex: 1, marginRight: 12 }}>{displayTitle}</h2>
                    <span className={`status-badge ${phaseBadge.cls}`}>{phaseBadge.text}</span>
                </div>
                <div style={{ display: "flex", gap: 16, fontSize: "0.8rem", color: "var(--text-muted)", flexWrap: "wrap", alignItems: "center" }}>
                    <span>{voteCount} vote{voteCount !== 1 ? "s" : ""}</span>
                    <span>{numOptions} options</span>
                    <span style={{ color: isGithubOrgElection || isEmailDomainElection || isTokenGateElection || isInviteCodeElection || isAllowlistElection ? "var(--accent)" : selfSignupAllowed ? "var(--accent)" : "var(--warning)", fontSize: "0.75rem" }}>
                        {gateLabel}
                    </span>
                    {gaslessEnabled && (
                        <span style={{ color: "var(--success)", fontSize: "0.75rem" }}>
                            &#9889; No wallet needed
                        </span>
                    )}
                    {isThresholdElection && thresholdMeta && (
                        <span style={{ color: "var(--purple)", fontSize: "0.75rem" }}>
                            {thresholdMeta.threshold}-of-{thresholdMeta.totalShares} committee
                        </span>
                    )}
                    {phase === "signup" && signupDeadline > 0 && (
                        <span>
                            {Date.now() / 1000 > signupDeadline
                                ? "Signup deadline passed"
                                : `Signup closes ${new Date(signupDeadline * 1000).toLocaleString()}`}
                        </span>
                    )}
                    {(phase === "voting" || phase === "closed") && votingDeadline > 0 && (
                        <span>
                            {Date.now() / 1000 > votingDeadline
                                ? "Voting deadline passed"
                                : `Voting closes ${new Date(votingDeadline * 1000).toLocaleString()}`}
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

            {/* Tabs */}
            <div className="nav" style={{ marginBottom: 16 }}>
                <button onClick={() => setTab("vote")} className={tab === "vote" ? "active" : ""}>
                    {phase === "signup" ? "Sign Up" : "Vote"}
                </button>
                <button onClick={() => setTab("results")} className={tab === "results" ? "active" : ""}>Results</button>
                {isOnChainCommittee && (
                    <button onClick={() => setTab("committee")} className={tab === "committee" ? "active" : ""}>Committee</button>
                )}
                {isAdmin && (
                    <button onClick={() => setTab("manage")} className={tab === "manage" ? "active" : ""}>Manage</button>
                )}
            </div>
        </>
    )
}
