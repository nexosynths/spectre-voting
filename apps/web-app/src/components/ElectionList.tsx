"use client"

import Link from "next/link"

interface ElectionInfo {
    address: string
    proposalId: string
    signupOpen: boolean
    votingOpen: boolean
    voteCount: number
    admin: string
    title: string
    phase: "signup" | "voting" | "closed"
    gateType: string
    gasless: boolean
}

const GATE_LABELS: Record<string, string> = {
    "invite-codes": "Invite codes",
    "allowlist": "Allowlist",
    "token-gate": "Token gate",
    "email-domain": "Email",
    "github-org": "GitHub",
}

interface ElectionListProps {
    elections: ElectionInfo[]
    loading: boolean
}

export default function ElectionList({ elections, loading }: ElectionListProps) {
    if (loading) {
        return (
            <div className="card" style={{ textAlign: "center", padding: 32 }}>
                <div className="spinner" style={{ margin: "0 auto 12px" }} />
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Loading elections...</p>
            </div>
        )
    }

    if (elections.length === 0) {
        return (
            <div className="card" style={{ textAlign: "center", padding: 32 }}>
                <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
                    No elections yet. Create the first one!
                </p>
            </div>
        )
    }

    return (
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
                        <div style={{ display: "flex", gap: 10, fontSize: "0.8rem", color: "var(--text-muted)", flexWrap: "wrap", alignItems: "center" }}>
                            <span>{e.voteCount} vote{e.voteCount !== 1 ? "s" : ""}</span>
                            {e.gateType && GATE_LABELS[e.gateType] && (
                                <span style={{ fontSize: "0.7rem", color: "var(--accent)" }}>{GATE_LABELS[e.gateType]}</span>
                            )}
                            {e.gasless && (
                                <span style={{ fontSize: "0.7rem", color: "var(--success)" }}>&#9889; No wallet</span>
                            )}
                        </div>
                    </div>
                </Link>
            ))}
        </div>
    )
}
