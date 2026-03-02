"use client"

import { useMode } from "@/context/ModeContext"

type GateType = "open" | "invite-codes" | "allowlist" | "admin-only" | "token-gate" | "email-domain" | "github-org"

interface TrustSummaryProps {
    gateType: GateType
    gaslessMode: boolean
    encryptionMode: "single" | "threshold"
    threshold?: number
    totalMembers?: number
}

interface Indicator {
    label: string
    value: string
    color: string // CSS variable
}

function getIndicators(props: TrustSummaryProps, isSimple: boolean): Indicator[] {
    const indicators: Indicator[] = []

    // Sybil resistance
    const sybilMap: Record<GateType, { value: string; color: string }> = {
        "open": { value: "None", color: "var(--warning)" },
        "invite-codes": { value: "Strong", color: "var(--success)" },
        "allowlist": { value: "Strong", color: "var(--success)" },
        "admin-only": { value: "Full", color: "var(--success)" },
        "token-gate": { value: "Medium", color: "var(--accent)" },
        "email-domain": { value: "Medium", color: "var(--accent)" },
        "github-org": { value: "Strong", color: "var(--success)" },
    }
    const sybil = sybilMap[props.gateType]
    indicators.push({ label: "Sybil resistance", value: sybil.value, color: sybil.color })

    // Vote privacy
    indicators.push({ label: "Vote privacy", value: "Encrypted + anonymous", color: "var(--success)" })

    // Key custody
    if (props.encryptionMode === "threshold" && props.threshold && props.totalMembers) {
        indicators.push({
            label: "Key custody",
            value: `${props.threshold}-of-${props.totalMembers} committee`,
            color: "var(--success)",
        })
    } else {
        indicators.push({
            label: "Key custody",
            value: isSimple ? "You (browser)" : "Single key (browser)",
            color: "var(--accent)",
        })
    }

    // Voter access
    if (props.gaslessMode) {
        indicators.push({ label: "Voter access", value: "No wallet needed", color: "var(--success)" })
    } else {
        indicators.push({ label: "Voter access", value: "Wallet required", color: "var(--accent)" })
    }

    return indicators
}

export default function TrustSummary(props: TrustSummaryProps) {
    const { isSimple } = useMode()
    const indicators = getIndicators(props, isSimple)

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
