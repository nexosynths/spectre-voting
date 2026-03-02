"use client"

interface WarningConfig {
    gateType: string
    gaslessMode: boolean
    encryptionMode: string
    signupHours: number
    votingHours: number
    numOptions: number
    threshold?: number
    totalMembers?: number
}

interface Warning {
    text: string
    severity: "high" | "medium" | "low"
}

function getWarnings(config: WarningConfig): Warning[] {
    const warnings: Warning[] = []

    if (config.gateType === "open" && config.gaslessMode) {
        warnings.push({
            text: "Open + gasless elections have no sybil resistance. Anyone can create multiple anonymous identities and vote repeatedly from different browsers.",
            severity: "high",
        })
    } else if (config.gateType === "open" && !config.gaslessMode) {
        warnings.push({
            text: "Open elections allow anyone with the link to sign up. Wallet requirement provides some sybil resistance, but users with multiple wallets can create multiple identities.",
            severity: "medium",
        })
    }

    if (config.encryptionMode === "single" && (config.signupHours + config.votingHours) > 168) {
        warnings.push({
            text: "Your election key is stored only in this browser. Elections longer than 7 days increase the risk of losing browser data. Consider committee mode for longer elections.",
            severity: "medium",
        })
    }

    if (config.threshold && config.totalMembers && config.threshold === config.totalMembers) {
        warnings.push({
            text: "Threshold equals total members \u2014 ALL members must participate to decrypt results. If any member is unavailable, results are permanently locked.",
            severity: "high",
        })
    }

    return warnings
}

export default function ContextualWarnings({ config }: { config: WarningConfig }) {
    const warnings = getWarnings(config)
    if (warnings.length === 0) return null

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {warnings.map((w, i) => (
                <div key={i} className={`trust-callout trust-callout-${w.severity === "high" ? "warning" : "caution"}`}>
                    {w.text}
                </div>
            ))}
        </div>
    )
}
