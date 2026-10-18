"use client"

import { ElectionFormState, ElectionFormDispatch } from "@/hooks/useElectionForm"
import ContextualWarnings from "@/components/ContextualWarning"
import TrustSummary from "@/components/TrustSummary"

interface Props {
    state: ElectionFormState
    dispatch: ElectionFormDispatch
    effectiveGasless: boolean
    canCreate: boolean
    onCreateElection: () => void
}

const gateLabels: Record<string, string> = {
    "open": "Open (anyone)",
    "invite-codes": "Invite codes",
    "allowlist": "Allowlist",
    "admin-only": "Admin only",
    "token-gate": "Token gate",
    "email-domain": "Email domain",
    "github-org": "GitHub org",
}

export default function StepReview({ state, dispatch, effectiveGasless, canCreate, onCreateElection }: Props) {
    const { creating } = state

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Summary */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <SummaryRow label="Title" value={state.electionTitle || "(empty)"} />
                <SummaryRow label="Options" value={state.optionLabels.filter(l => l.trim()).join(", ") || "(none)"} />
                <SummaryRow label="Signup" value={Number(state.signupHours) > 0 ? `${state.signupHours} hours` : "Until you close it"} />
                <SummaryRow label="Voting ends" value={`${state.votingHours} hours after signup${Number(state.signupHours) > 0 ? " ends" : " opens (fixed at creation)"}`} />
                <SummaryRow label="Access" value={gateLabels[state.gateType] || state.gateType} />
                {state.gateType === "invite-codes" && (
                    <SummaryRow label="Codes" value={`${state.codeCount} invite codes`} />
                )}
                {state.gateType === "token-gate" && (
                    <SummaryRow label="Token" value={`${state.tokenSymbol || state.tokenAddress} (min ${state.tokenMinBalance})`} />
                )}
                {state.gateType === "email-domain" && (
                    <SummaryRow label="Domains" value={state.emailDomains} />
                )}
                {state.gateType === "github-org" && (
                    <SummaryRow label="Org" value={state.githubOrg} />
                )}
                <SummaryRow label="Wallet" value={effectiveGasless ? "Not required (gasless)" : "Needed to sign up"} />
                <SummaryRow label="Ballots" value="Sealed until the deadline; anyone can recount after" />
            </div>

            {/* Contextual warnings */}
            <ContextualWarnings config={{
                gateType: state.gateType,
                gaslessMode: effectiveGasless,
                signupHours: Number(state.signupHours) || 0,
                votingHours: Number(state.votingHours) || 0,
                numOptions: state.optionLabels.length,
                weightedVoting: state.gateType === "token-gate" && state.weightedVoting,
            }} />

            {/* Trust summary */}
            <TrustSummary
                gateType={state.gateType}
                gaslessMode={effectiveGasless}
            />

            {/* Create button */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", flex: 1 }}>
                    Signup: {Number(state.signupHours) > 0 ? `${state.signupHours}h` : "manual close"} · Voting: {state.votingHours}h · Share link auto-copied
                </p>
                <button
                    className="btn-primary"
                    onClick={onCreateElection}
                    disabled={!canCreate}
                    style={{ width: "auto", padding: "12px 20px" }}
                >
                    {creating ? "Creating..." : "Create Election"}
                </button>
            </div>
        </div>
    )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
            <span style={{ fontSize: "0.8rem", fontWeight: 500, textAlign: "right", maxWidth: "60%" }}>{value}</span>
        </div>
    )
}
