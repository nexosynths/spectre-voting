"use client"

import { useMode } from "@/context/ModeContext"
import TrustCallout from "./TrustCallout"

type GateType = "open" | "invite-codes" | "allowlist" | "admin-only"

interface GateSelectorProps {
    gateType: GateType
    setGateType: (g: GateType) => void
    codeCount: string
    setCodeCount: (v: string) => void
    allowlistInput: string
    setAllowlistInput: (v: string) => void
    disabled?: boolean
}

const SIMPLE_GATES: Array<{ key: GateType; label: string; desc: string }> = [
    { key: "open", label: "Anyone", desc: "Anyone with the link can vote" },
    { key: "allowlist", label: "People on a list", desc: "You specify who can participate" },
    { key: "invite-codes", label: "Invite codes", desc: "One code per voter" },
]

const ADVANCED_GATES: Array<{ key: GateType; label: string; desc: string }> = [
    { key: "open", label: "Open", desc: "Anyone with the link can vote" },
    { key: "invite-codes", label: "Invite Codes", desc: "One-time codes you distribute" },
    { key: "allowlist", label: "Allowlist", desc: "Only people on your list" },
    { key: "admin-only", label: "Admin Only", desc: "You register each voter" },
]

const TRUST_SIMPLE: Record<string, { text: string; variant: "info" | "caution" | "warning" }> = {
    "open": { text: "Anyone with the link can vote. If this link leaks, unwanted people can join. Use invite codes or an allowlist for controlled access.", variant: "caution" },
    "allowlist": { text: "Only people you list can vote. They enter their name or email to join.", variant: "info" },
    "invite-codes": { text: "Each code works once. Distribute codes privately to the people you want to vote.", variant: "info" },
}

const TRUST_ADVANCED: Record<string, { text: string; variant: "info" | "caution" | "warning" }> = {
    "open": { text: "No eligibility restriction. Sybil resistance: none.", variant: "caution" },
    "invite-codes": { text: "Application-layer enforcement via relay. Direct contract calls can bypass. Acceptable for gasless elections where relay is the only submission path.", variant: "info" },
    "allowlist": { text: "Relay validates identifiers against on-chain keccak256 hashes. Identifiers are not cryptographically bound to the person.", variant: "info" },
    "admin-only": { text: "Strongest control. Only admin can register voters on-chain.", variant: "info" },
}

export default function GateSelector({
    gateType, setGateType, codeCount, setCodeCount,
    allowlistInput, setAllowlistInput, disabled,
}: GateSelectorProps) {
    const { isSimple } = useMode()
    const gates = isSimple ? SIMPLE_GATES : ADVANCED_GATES
    const trustMap = isSimple ? TRUST_SIMPLE : TRUST_ADVANCED
    const trust = trustMap[gateType]

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
                            minWidth: isSimple ? "calc(33% - 6px)" : "calc(50% - 4px)",
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
        </div>
    )
}
