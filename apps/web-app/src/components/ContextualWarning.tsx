"use client"

interface WarningConfig {
    gateType: string
    gaslessMode: boolean
    signupHours: number
    votingHours: number
    numOptions: number
    weightedVoting: boolean
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
            text: "Open elections allow anyone with the link to sign up. Requiring a wallet gives a little sybil resistance, but people with several wallets can create several identities.",
            severity: "medium",
        })
    }

    if (config.gateType === "token-gate") {
        warnings.push({
            text: "Token balances are checked at signup, not at a snapshot. Tokens moved to another wallet during signup can qualify it too.",
            severity: "medium",
        })
    }

    if (config.weightedVoting) {
        warnings.push({
            text: "Weighted votes are public after the deadline, and weights are visible at signup. A voter with an unusual weight can be linked from signup to ballot.",
            severity: "high",
        })
    }

    if (config.votingHours > 0 && config.votingHours < 1) {
        warnings.push({
            text: "Voting lasts under an hour, and the deadline can't be extended. Voters need time to sign up and generate two proofs.",
            severity: "medium",
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
