"use client"

import { ElectionFormState, ElectionFormDispatch, CommitteeMember } from "@/hooks/useElectionForm"
import { isAddress } from "ethers"
import ContextualWarnings from "@/components/ContextualWarning"
import TrustSummary from "@/components/TrustSummary"

interface Props {
    state: ElectionFormState
    dispatch: ElectionFormDispatch
    effectiveGasless: boolean
    validCommitteeMembers: CommitteeMember[]
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

export default function StepReview({ state, dispatch, effectiveGasless, validCommitteeMembers, canCreate, onCreateElection }: Props) {
    const { creating } = state

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Summary */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <SummaryRow label="Title" value={state.electionTitle || "(empty)"} />
                <SummaryRow label="Options" value={state.optionLabels.filter(l => l.trim()).join(", ") || "(none)"} />
                <SummaryRow label="Signup" value={`${state.signupHours || 24} hours`} />
                <SummaryRow label="Voting" value={`${state.votingHours || 72} hours`} />
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
                <SummaryRow label="Wallet" value={effectiveGasless ? "Not required (gasless)" : "Required"} />
                <SummaryRow
                    label="Security"
                    value={state.encryptionMode === "threshold"
                        ? `${state.threshold}-of-${validCommitteeMembers.length} committee`
                        : "Single key (you)"}
                />
            </div>

            {/* Contextual warnings */}
            <ContextualWarnings config={{
                gateType: state.gateType,
                gaslessMode: effectiveGasless,
                encryptionMode: state.encryptionMode,
                signupHours: Number(state.signupHours) || 24,
                votingHours: Number(state.votingHours) || 72,
                numOptions: state.optionLabels.length,
                threshold: state.encryptionMode === "threshold" ? state.threshold : undefined,
                totalMembers: state.encryptionMode === "threshold" ? validCommitteeMembers.length : undefined,
            }} />

            {/* Trust summary */}
            <TrustSummary
                gateType={state.gateType}
                gaslessMode={effectiveGasless}
                encryptionMode={state.encryptionMode}
                threshold={state.encryptionMode === "threshold" ? state.threshold : undefined}
                totalMembers={state.encryptionMode === "threshold" ? validCommitteeMembers.length : undefined}
            />

            {/* Create button */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", flex: 1 }}>
                    Signup: {state.signupHours || 24}h · Voting: {state.votingHours || 72}h · Share link auto-copied
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
