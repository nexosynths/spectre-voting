"use client"

import TrustCallout from "./TrustCallout"

export type GateType = "open" | "invite-codes" | "allowlist" | "admin-only" | "token-gate" | "email-domain" | "github-org"

interface GateSelectorProps {
    gateType: GateType
    setGateType: (g: GateType) => void
    codeCount: string
    setCodeCount: (v: string) => void
    allowlistInput: string
    setAllowlistInput: (v: string) => void
    tokenAddress: string
    setTokenAddress: (v: string) => void
    tokenType: "erc20" | "erc721"
    setTokenType: (v: "erc20" | "erc721") => void
    tokenMinBalance: string
    setTokenMinBalance: (v: string) => void
    tokenSymbol: string
    tokenDecimals: number
    weightedVoting: boolean
    setWeightedVoting: (v: boolean) => void
    voteThreshold: string
    setVoteThreshold: (v: string) => void
    emailDomains: string
    setEmailDomains: (v: string) => void
    githubOrg: string
    setGithubOrg: (v: string) => void
    disabled?: boolean
}

const GATES: Array<{ key: GateType; label: string; desc: string }> = [
    { key: "open", label: "Anyone", desc: "Anyone with the link can vote" },
    { key: "allowlist", label: "Allowlist", desc: "You specify who can participate" },
    { key: "invite-codes", label: "Invite codes", desc: "One code per voter" },
    { key: "email-domain", label: "Email domain", desc: "Must verify a company email" },
    { key: "github-org", label: "GitHub org", desc: "Must be in a GitHub organization" },
    { key: "token-gate", label: "Token holders", desc: "Must hold a token or NFT" },
    { key: "admin-only", label: "Admin only", desc: "You register each voter" },
]

const TRUST_MAP: Record<string, { text: string; variant: "info" | "caution" | "warning" }> = {
    "open": { text: "Anyone with the link can vote. If this link leaks, unwanted people can join. Use invite codes or an allowlist for controlled access.", variant: "caution" },
    "allowlist": { text: "Only people you list can vote. They enter their identifier to join.", variant: "info" },
    "invite-codes": { text: "Each code works once. Distribute codes privately to the people you want to vote.", variant: "info" },
    "email-domain": { text: "Voters verify their email at your domain(s). One vote per email address.", variant: "info" },
    "github-org": { text: "Voters sign in with GitHub to prove org membership. One vote per GitHub account.", variant: "info" },
    "token-gate": { text: "Only people who hold the required token or NFT can vote. Voters must connect a wallet.", variant: "info" },
    "admin-only": { text: "Only you can register voters. Strongest control over who participates.", variant: "info" },
}

export default function GateSelector({
    gateType, setGateType, codeCount, setCodeCount,
    allowlistInput, setAllowlistInput,
    tokenAddress, setTokenAddress, tokenType, setTokenType,
    tokenMinBalance, setTokenMinBalance, tokenSymbol, tokenDecimals,
    weightedVoting, setWeightedVoting, voteThreshold, setVoteThreshold,
    emailDomains, setEmailDomains,
    githubOrg, setGithubOrg,
    disabled,
}: GateSelectorProps) {
    const gates = GATES
    const trust = TRUST_MAP[gateType]

    return (
        <div>
            <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                Who can vote?
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {gates.map(g => (
                    <div
                        key={g.key}
                        onClick={() => !disabled && setGateType(g.key)}
                        style={{
                            flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: disabled ? "not-allowed" : "pointer",
                            border: `1px solid ${gateType === g.key ? "var(--accent)" : "var(--border)"}`,
                            background: gateType === g.key ? "var(--accent-bg)" : "var(--bg)",
                            minWidth: "calc(33% - 6px)",
                        }}
                    >
                        <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{g.label}</span>
                        <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>{g.desc}</p>
                    </div>
                ))}
            </div>

            {/* Trust callout for selected gate */}
            {trust && <TrustCallout text={trust.text} variant={trust.variant} />}

            {/* Invite codes config */}
            {gateType === "invite-codes" && (
                <div style={{ marginTop: 8, padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        Number of invite codes (2-250)
                    </label>
                    <input
                        type="number"
                        min={2}
                        max={250}
                        value={codeCount}
                        onChange={e => setCodeCount(e.target.value)}
                        disabled={disabled}
                        style={{ width: 100, fontSize: "0.85rem" }}
                    />
                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 4 }}>
                        Each code lets one voter sign up. Codes are shown after election creation.
                    </p>
                </div>
            )}

            {/* Allowlist config */}
            {gateType === "allowlist" && (
                <div style={{ marginTop: 8, padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        One identifier per line (email, name, ID...)
                    </label>
                    <textarea
                        placeholder={"alice@example.com\nbob@example.com\ncharlie smith"}
                        value={allowlistInput}
                        onChange={e => setAllowlistInput(e.target.value)}
                        disabled={disabled}
                        rows={5}
                        style={{ width: "100%", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", padding: "10px 14px", fontFamily: "inherit", fontSize: "0.85rem", resize: "vertical", outline: "none", marginBottom: 4 }}
                    />
                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)" }}>
                        {(() => {
                            const count = [...new Set(allowlistInput.split("\n").map(s => s.trim()).filter(Boolean))].length
                            return `${count} identifier${count !== 1 ? "s" : ""}`
                        })()} — Voters enter their identifier to sign up
                    </p>
                </div>
            )}

            {/* Email domain config */}
            {gateType === "email-domain" && (
                <div style={{ marginTop: 8, padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        Allowed email domain(s)
                    </label>
                    <input
                        type="text"
                        placeholder="company.com, subsidiary.org"
                        value={emailDomains}
                        onChange={e => setEmailDomains(e.target.value)}
                        disabled={disabled}
                        style={{ width: "100%", fontSize: "0.85rem" }}
                    />
                    {(() => {
                        const domains = emailDomains.split(",").map(d => d.trim().toLowerCase()).filter(Boolean)
                        return domains.length > 0 ? (
                            <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 6 }}>
                                {domains.length} domain{domains.length !== 1 ? "s" : ""}: {domains.map(d => "@" + d).join(", ")}
                            </p>
                        ) : null
                    })()}
                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 4 }}>
                        Voters verify their email to join. No wallet needed.
                    </p>
                </div>
            )}

            {/* GitHub org config */}
            {gateType === "github-org" && (
                <div style={{ marginTop: 8, padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        GitHub organization name
                    </label>
                    <input
                        type="text"
                        placeholder="my-org"
                        value={githubOrg}
                        onChange={e => setGithubOrg(e.target.value.replace(/[^a-zA-Z0-9-]/g, ""))}
                        disabled={disabled}
                        className="mono"
                        style={{ width: "100%", fontSize: "0.85rem" }}
                    />
                    {githubOrg.trim() && (
                        <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 6 }}>
                            github.com/{githubOrg}
                        </p>
                    )}
                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 4 }}>
                        Voters sign in with GitHub to prove they&apos;re in this org. No wallet needed.
                    </p>
                </div>
            )}

            {/* Token gate config */}
            {gateType === "token-gate" && (
                <div style={{ marginTop: 8, padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        {(["erc20", "erc721"] as const).map(t => (
                            <div
                                key={t}
                                onClick={() => !disabled && setTokenType(t)}
                                style={{
                                    flex: 1, padding: "8px 12px", borderRadius: "var(--radius)", cursor: disabled ? "not-allowed" : "pointer",
                                    border: `1px solid ${tokenType === t ? "var(--accent)" : "var(--border)"}`,
                                    background: tokenType === t ? "var(--accent-bg)" : "transparent",
                                    textAlign: "center",
                                }}
                            >
                                <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{t === "erc20" ? "ERC-20 Token" : "NFT (ERC-721)"}</span>
                            </div>
                        ))}
                    </div>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        Token contract address
                    </label>
                    <input
                        type="text"
                        placeholder="0x..."
                        value={tokenAddress}
                        onChange={e => setTokenAddress(e.target.value)}
                        disabled={disabled}
                        className="mono"
                        style={{ width: "100%", fontSize: "0.8rem", marginBottom: 8 }}
                    />
                    {tokenType === "erc20" && (
                        <>
                            <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                                Minimum balance required
                            </label>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <input
                                    type="text"
                                    placeholder="1"
                                    value={tokenMinBalance}
                                    onChange={e => setTokenMinBalance(e.target.value.replace(/[^0-9.]/g, ""))}
                                    disabled={disabled}
                                    style={{ width: 120, fontSize: "0.85rem" }}
                                />
                                {tokenSymbol && (
                                    <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{tokenSymbol}</span>
                                )}
                            </div>
                        </>
                    )}
                    {tokenSymbol && (
                        <p style={{ fontSize: "0.65rem", color: "var(--success)", marginTop: 6 }}>
                            Token found: {tokenSymbol} {tokenDecimals > 0 ? `(${tokenDecimals} decimals)` : ""}
                        </p>
                    )}
                    {tokenAddress.length === 42 && !tokenSymbol && (
                        <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 6 }}>
                            Verifying token contract...
                        </p>
                    )}

                    {/* Weighted voting toggle */}
                    <div style={{ marginTop: 10, padding: "8px 12px", background: "var(--bg-card)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: disabled ? "not-allowed" : "pointer" }}>
                            <input
                                type="checkbox"
                                checked={weightedVoting}
                                onChange={e => !disabled && setWeightedVoting(e.target.checked)}
                                disabled={disabled}
                            />
                            <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                                Weighted voting
                            </span>
                        </label>
                        {weightedVoting && (
                            <div style={{ marginTop: 6 }}>
                                <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginBottom: 4 }}>
                                    {tokenType === "erc721"
                                        ? "Each NFT held = 1 vote (max 255)"
                                        : "Set how many tokens = 1 vote"}
                                </p>
                                {tokenType === "erc20" && (
                                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                        <input
                                            type="text"
                                            placeholder="100"
                                            value={voteThreshold}
                                            onChange={e => setVoteThreshold(e.target.value.replace(/[^0-9.]/g, ""))}
                                            disabled={disabled}
                                            style={{ width: 120, fontSize: "0.85rem" }}
                                        />
                                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                            {tokenSymbol || "tokens"} per vote
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                        {!weightedVoting && (
                            <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 4 }}>
                                Every eligible voter gets 1 vote regardless of balance
                            </p>
                        )}
                    </div>

                    <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 6 }}>
                        Voters must connect a wallet to prove they hold the token.
                    </p>
                </div>
            )}
        </div>
    )
}
