"use client"

import { ElectionFormState } from "@/hooks/useElectionForm"
import TrustCallout from "@/components/TrustCallout"

interface Props {
    state: ElectionFormState
    effectiveGasless: boolean
}

/** Informational step: there are no key choices to make, because nobody holds a key. */
export default function StepSecurity({ state, effectiveGasless }: Props) {
    const gated = state.gateType !== "open" && state.gateType !== "admin-only"
    const items: { title: string; text: string }[] = [
        {
            title: "Sealed until the deadline",
            text: "Each ballot is time-locked with drand to the voting deadline. Nobody holds a key, so nobody, including you, can read a ballot or a running tally before voting ends. Voting can't be closed early.",
        },
        {
            title: "Anyone can count",
            text: "After the deadline, anyone can open the ballots with the public drand beacon and recount. Opened ballots are public, listed by anonymous voter tags.",
        },
        {
            title: "Separated from signup",
            text: "A zero-knowledge proof separates each vote from its signup, and the relay submits joins and ballots, so a voter's wallet never appears on their ballot.",
        },
        {
            title: "What you and the relay can see",
            text: gated
                ? "You can see who registered. The relay checks the signup requirement, so it's trusted to apply it fairly, and it sees which credential registered and voters' network details, like IP addresses."
                : effectiveGasless
                    ? "You can see who registered if you register them yourself. The relay submits signups, joins and ballots, and sees voters' network details, like IP addresses."
                    : "Signups come from voters' own wallets, so who registered is public. The relay submits joins and ballots and sees voters' network details, like IP addresses.",
        },
    ]

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map(item => (
                <div key={item.title} style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{item.title}</span>
                    <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>{item.text}</p>
                </div>
            ))}
            <TrustCallout
                variant="caution"
                text={`Voting ends ${Number(state.signupHours) > 0 ? `${state.signupHours}h + ` : ""}${state.votingHours || "?"}h after you create the election. The deadline is fixed: it can't be moved or ended early. This is a research prototype; don't use it for votes that matter.`}
            />
        </div>
    )
}
