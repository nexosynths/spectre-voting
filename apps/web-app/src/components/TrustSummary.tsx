"use client"

type GateType = "open" | "invite-codes" | "allowlist" | "admin-only" | "token-gate" | "email-domain" | "github-org"

interface TrustSummaryProps {
    gateType: GateType
    gaslessMode: boolean
}

interface Indicator {
    label: string
    value: string
    color: string // CSS variable
}

function getIndicators(props: TrustSummaryProps): Indicator[] {
    const indicators: Indicator[] = []

    // Sybil resistance, and who enforces it
    const sybilMap: Record<GateType, { value: string; color: string }> = {
        "open": { value: "None", color: "var(--warning)" },
        "invite-codes": { value: "One per code (relay checks)", color: "var(--success)" },
        "allowlist": { value: "One per entry (relay checks)", color: "var(--success)" },
        "admin-only": { value: "You register each voter", color: "var(--success)" },
        "token-gate": { value: "One per wallet (relay checks)", color: "var(--accent)" },
        "email-domain": { value: "One per email (relay checks)", color: "var(--accent)" },
        "github-org": { value: "One per account (relay checks)", color: "var(--success)" },
    }
    const sybil = sybilMap[props.gateType]
    indicators.push({ label: "Sybil resistance", value: sybil.value, color: sybil.color })

    indicators.push({ label: "Ballot secrecy", value: "Sealed until the deadline (drand)", color: "var(--success)" })
    indicators.push({ label: "Results", value: "Anyone can recount after the deadline", color: "var(--success)" })
    indicators.push({ label: "Election key", value: "None: nobody can decrypt early", color: "var(--success)" })

    if (props.gaslessMode) {
        indicators.push({ label: "Voter access", value: "No wallet needed", color: "var(--success)" })
    } else {
        indicators.push({ label: "Voter access", value: "Wallet needed to sign up", color: "var(--accent)" })
    }

    return indicators
}

export default function TrustSummary(props: TrustSummaryProps) {
    const indicators = getIndicators(props)

    return (
        <div className="trust-summary">
            {indicators.map((ind, i) => (
                <div key={i} className="trust-summary-item">
                    <span className="trust-summary-label">{ind.label}</span>
                    <span className="trust-summary-value" style={{ color: ind.color }}>{ind.value}</span>
                </div>
            ))}
        </div>
    )
}
