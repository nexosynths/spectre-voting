"use client"

import { ElectionFormState } from "@/hooks/useElectionForm"
import TrustCallout from "@/components/TrustCallout"
import { SEAL_DELAY_SECONDS } from "@/lib/sealing"

interface Props {
    state: ElectionFormState
    effectiveGasless: boolean
}

/** Informational step: there are no key choices to make, because nobody holds a key. */
export default function StepSecurity({ state, effectiveGasless }: Props) {
    const gated = state.gateType !== "open" && state.gateType !== "admin-only"
    const items: { title: string; text: string }[] = [
        {
            title: "Sealed until after the deadline",
            text: `Each ballot is time-locked with drand until ${SEAL_DELAY_SECONDS / 3600} hours after the voting deadline, long enough that a stalled chain can't let anyone read ballots and still vote. Nobody holds a key, so nobody, including you, can read a ballot or a running tally before then. Voting can't be closed early.`,
        },
        {
            title: "Anyone can count",
            text: "Once ballots unseal, anyone can open them with the public drand beacon and recount. Opened ballots are public, listed by anonymous voter tags.",
        },
        {
            title: "Not linked on-chain",
            text: "A zero-knowledge proof separates each vote from its signup, and the relay submits joins and ballots, so the chain doesn't record which signup or wallet cast which ballot. In weighted elections, an unusual weight can still link them.",
        },
        {
            title: "What you and the relay can see",
            text: gated
                ? "You can see who registered. The relay checks the signup requirement, so it's trusted to apply it fairly. It sees which credential registered and voters' IP addresses at signup and when they vote, so once ballots are public its operator could link a voter's credential to their ballot. The public RPC service voters' browsers read the chain through also sees their IP addresses."
                : effectiveGasless
                    ? "You can see who registered if you register them yourself. The relay submits signups, joins and ballots and sees voters' IP addresses, so once ballots are public its operator could link them to ballots. The public RPC service voters' browsers read the chain through also sees their IP addresses."
                    : "Signups come from voters' own wallets, so who registered is public. The relay submits joins and ballots and sees voters' IP addresses, so once ballots are public its operator could link them to ballots. The public RPC service voters' browsers read the chain through also sees their IP addresses.",
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
                text={`Signup ends ${state.signupHours || "?"}h after you create the election (you can end it earlier), and voting ends ${state.votingHours || "?"}h after that. The voting deadline is fixed: it can't be moved or ended early. Results can be counted ${SEAL_DELAY_SECONDS / 3600} hours after it. This is a research prototype; don't use it for votes that matter.`}
            />
        </div>
    )
}
