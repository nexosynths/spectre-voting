"use client"

import { getAdminCodes, codesToCsv, downloadCsv, getAdminAllowlist, allowlistToCsv } from "@/lib/inviteCodes"

interface ManageTabProps {
    phase: "signup" | "voting" | "closed"
    isAdmin: boolean
    electionAddress: string
    shareUrl: string
    isInviteCodeElection: boolean
    isAllowlistElection: boolean
    inviteCodeMeta: { totalCodes: number; codeHashes: string[] } | null
    allowlistMeta: { totalEntries: number; identifierHashes: string[] } | null
    commitment: string
    setCommitment: (v: string) => void
    bulkCommitments: string
    setBulkCommitments: (v: string) => void
    adminLoading: boolean
    adminMsg: string
    registerVoter: () => void
    registerBulk: () => void
    handleCloseSignup: () => void
    handleCloseVoting: () => void
    copyToClipboard: (text: string, label: string) => void
    copied: string
    setCopied: (v: string) => void
}

export default function ManageTab({
    phase, isAdmin, electionAddress, shareUrl,
    isInviteCodeElection, isAllowlistElection,
    inviteCodeMeta, allowlistMeta,
    commitment, setCommitment, bulkCommitments, setBulkCommitments,
    adminLoading, adminMsg, registerVoter, registerBulk,
    handleCloseSignup, handleCloseVoting,
    copyToClipboard, copied, setCopied,
}: ManageTabProps) {
    if (!isAdmin) return null

    return (
        <>
            {/* Share link */}
            <div className="card" style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Share Election</h4>
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                    {isAllowlistElection
                        ? "Use the per-identifier share links below to send voters a link with their identifier pre-filled."
                        : isInviteCodeElection
                            ? "Use the per-code share links below to send voters a link with their code pre-filled."
                            : phase === "signup" && !isInviteCodeElection && !isAllowlistElection
                                ? "Send this link to voters. They can sign up directly during the signup phase."
                                : "Send this link to voters. Since this is a gated election, you\u2019ll need to register them via the form below."}
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <code className="mono" style={{ flex: 1, background: "var(--bg)", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.65rem", minWidth: 0 }}>
                        {shareUrl}
                    </code>
                    <button onClick={() => copyToClipboard(shareUrl, "share2")} className="btn-primary" style={{ width: "auto", padding: "10px 16px", fontSize: "0.8rem" }}>
                        {copied === "share2" ? "Copied!" : "Copy"}
                    </button>
                </div>
            </div>

            {/* Invite codes section (admin) */}
            {isInviteCodeElection && (() => {
                const adminCodes = getAdminCodes(electionAddress)
                return (
                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>
                            Invite Codes ({inviteCodeMeta?.totalCodes || 0} total)
                        </h4>
                        {adminCodes ? (
                            <>
                                <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 12, padding: "8px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                    {adminCodes.map((code, i) => {
                                        const codeShareUrl = `${shareUrl}?code=${code}`
                                        return (
                                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < adminCodes.length - 1 ? "1px solid var(--border)" : "none" }}>
                                                <code className="mono" style={{ fontSize: "0.8rem" }}>{code}</code>
                                                <button
                                                    onClick={() => { navigator.clipboard.writeText(codeShareUrl); setCopied(`clink-${i}`); setTimeout(() => setCopied(""), 2000) }}
                                                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}
                                                >{copied === `clink-${i}` ? "Copied!" : "Copy link"}</button>
                                            </div>
                                        )
                                    })}
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                        className="btn-primary"
                                        onClick={() => { navigator.clipboard.writeText(adminCodes.join("\n")); setCopied("admin-all-codes"); setTimeout(() => setCopied(""), 2000) }}
                                        style={{ flex: 1, fontSize: "0.8rem" }}
                                    >{copied === "admin-all-codes" ? "Copied!" : "Copy All Codes"}</button>
                                    <button
                                        className="btn-secondary"
                                        onClick={() => {
                                            const csv = codesToCsv(adminCodes, shareUrl)
                                            downloadCsv(csv, `invite-codes-${electionAddress.slice(0, 8)}.csv`)
                                        }}
                                        style={{ flex: 1, fontSize: "0.8rem" }}
                                    >Download CSV</button>
                                </div>
                            </>
                        ) : (
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                Codes not available in this browser. They are only stored in the browser that created the election. Total codes from metadata: {inviteCodeMeta?.totalCodes || "unknown"}.
                            </p>
                        )}
                    </div>
                )
            })()}

            {/* Allowlist section (admin) */}
            {isAllowlistElection && (() => {
                const adminAllowlist = getAdminAllowlist(electionAddress)
                return (
                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>
                            Allowlist ({allowlistMeta?.totalEntries || 0} entries)
                        </h4>
                        {adminAllowlist ? (
                            <>
                                <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 12, padding: "8px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                    {adminAllowlist.map((id, i) => {
                                        const idShareUrl = `${shareUrl}?id=${encodeURIComponent(id)}`
                                        return (
                                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < adminAllowlist.length - 1 ? "1px solid var(--border)" : "none" }}>
                                                <span style={{ fontSize: "0.8rem" }}>{id}</span>
                                                <button
                                                    onClick={() => { navigator.clipboard.writeText(idShareUrl); setCopied(`alink-${i}`); setTimeout(() => setCopied(""), 2000) }}
                                                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}
                                                >{copied === `alink-${i}` ? "Copied!" : "Copy link"}</button>
                                            </div>
                                        )
                                    })}
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                        className="btn-primary"
                                        onClick={() => { navigator.clipboard.writeText(adminAllowlist.join("\n")); setCopied("admin-all-ids"); setTimeout(() => setCopied(""), 2000) }}
                                        style={{ flex: 1, fontSize: "0.8rem" }}
                                    >{copied === "admin-all-ids" ? "Copied!" : "Copy All Identifiers"}</button>
                                    <button
                                        className="btn-secondary"
                                        onClick={() => {
                                            const csv = allowlistToCsv(adminAllowlist, shareUrl)
                                            downloadCsv(csv, `allowlist-${electionAddress.slice(0, 8)}.csv`)
                                        }}
                                        style={{ flex: 1, fontSize: "0.8rem" }}
                                    >Download CSV</button>
                                </div>
                            </>
                        ) : (
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                Identifiers not available in this browser. They are only stored in the browser that created the election. Total entries from metadata: {allowlistMeta?.totalEntries || "unknown"}.
                            </p>
                        )}
                    </div>
                )
            })()}

            {/* Admin register (during signup phase) */}
            {phase === "signup" && (
                <>
                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>Register Voter</h4>
                        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                            {!isInviteCodeElection && !isAllowlistElection
                                ? "Each voter visits this election page, creates their identity, and copies their Voter ID. Paste it here to register them."
                                : "You can also register voters directly by pasting their Voter ID."}
                        </p>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <input placeholder="Paste Voter ID here" value={commitment} onChange={e => setCommitment(e.target.value)} disabled={adminLoading} style={{ flex: 1, minWidth: 0 }} />
                            <button className="btn-primary" onClick={registerVoter} disabled={adminLoading || !commitment.trim()} style={{ width: "auto", padding: "12px 18px" }}>
                                {adminLoading ? "..." : "Register"}
                            </button>
                        </div>
                    </div>

                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>Bulk Register</h4>
                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                            Register multiple voters at once. One Voter ID per line.
                        </p>
                        <textarea placeholder="One Voter ID per line..." value={bulkCommitments} onChange={e => setBulkCommitments(e.target.value)} disabled={adminLoading} rows={3}
                            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", padding: "10px 14px", fontFamily: "inherit", fontSize: "0.85rem", resize: "vertical", outline: "none", marginBottom: 8 }} />
                        <button className="btn-primary" onClick={registerBulk} disabled={adminLoading || !bulkCommitments.trim()}>
                            {adminLoading ? "Processing..." : "Register All"}
                        </button>
                    </div>
                </>
            )}

            {/* Close signup */}
            {phase === "signup" && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Close Signup &amp; Open Voting</h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                        Close registration and open the anonymous join + voting phase. Voters who signed up can now anonymously re-key and vote.
                    </p>
                    <button className="btn-primary" onClick={handleCloseSignup} disabled={adminLoading}>
                        {adminLoading ? "Closing..." : "Close Signup"}
                    </button>
                </div>
            )}

            {/* Close voting */}
            {phase === "voting" && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--error)" }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8, color: "var(--error)" }}>Close Voting</h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 10 }}>
                        Permanently close this election. No more joins or votes will be accepted.
                    </p>
                    <button className="btn-secondary" onClick={handleCloseVoting} disabled={adminLoading} style={{ borderColor: "var(--error)", color: "var(--error)" }}>
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
    )
}
