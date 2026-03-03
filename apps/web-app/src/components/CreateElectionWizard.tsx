"use client"

import { ElectionFormState, ElectionFormDispatch, CommitteeMember } from "@/hooks/useElectionForm"
import StepBasics from "@/components/wizard/StepBasics"
import StepAccess from "@/components/wizard/StepAccess"
import StepSecurity from "@/components/wizard/StepSecurity"
import StepReview from "@/components/wizard/StepReview"

interface Props {
    state: ElectionFormState
    dispatch: ElectionFormDispatch
    effectiveGasless: boolean
    gaslessLocked: boolean
    walletForced: boolean
    gaslessForced: boolean
    validCommitteeMembers: CommitteeMember[]
    canProceedFromStep: boolean[]
    canCreate: boolean
    onCreateElection: () => void
}

const STEPS = [
    { label: "Basics", title: "What are you voting on?" },
    { label: "Access", title: "Who can vote?" },
    { label: "Security", title: "Results security" },
    { label: "Review", title: "Review & create" },
]

export default function CreateElectionWizard({
    state, dispatch,
    effectiveGasless, gaslessLocked, walletForced, gaslessForced,
    validCommitteeMembers, canProceedFromStep, canCreate,
    onCreateElection,
}: Props) {
    const { currentStep, creating } = state

    return (
        <div className="card" style={{ marginBottom: 16 }}>
            {/* Step indicator */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
                {STEPS.map((step, i) => {
                    const isActive = i === currentStep
                    const isCompleted = i < currentStep
                    const isClickable = i < currentStep && !creating

                    return (
                        <button
                            key={i}
                            onClick={() => isClickable && dispatch({ type: "GO_TO_STEP", step: i })}
                            style={{
                                flex: 1,
                                padding: "8px 4px",
                                fontSize: "0.7rem",
                                fontWeight: isActive ? 700 : 500,
                                color: isActive ? "var(--accent)" : isCompleted ? "var(--text)" : "var(--text-muted)",
                                background: isActive ? "var(--accent-bg)" : "transparent",
                                border: "none",
                                borderBottom: `2px solid ${isActive ? "var(--accent)" : isCompleted ? "var(--text-muted)" : "var(--border)"}`,
                                cursor: isClickable ? "pointer" : "default",
                                transition: "all 0.2s",
                                textAlign: "center",
                            }}
                        >
                            {i + 1}. {step.label}
                        </button>
                    )
                })}
            </div>

            {/* Step title */}
            <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: 14 }}>
                {STEPS[currentStep].title}
            </h3>

            {/* Step content */}
            {currentStep === 0 && (
                <StepBasics state={state} dispatch={dispatch} />
            )}
            {currentStep === 1 && (
                <StepAccess
                    state={state} dispatch={dispatch}
                    effectiveGasless={effectiveGasless}
                    gaslessLocked={gaslessLocked}
                    walletForced={walletForced}
                    gaslessForced={gaslessForced}
                />
            )}
            {currentStep === 2 && (
                <StepSecurity state={state} dispatch={dispatch} />
            )}
            {currentStep === 3 && (
                <StepReview
                    state={state} dispatch={dispatch}
                    effectiveGasless={effectiveGasless}
                    validCommitteeMembers={validCommitteeMembers}
                    canCreate={canCreate}
                    onCreateElection={onCreateElection}
                />
            )}

            {/* Navigation (Back / Next) — hidden on Review step which has its own Create button */}
            {currentStep < 3 && (
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
                    <button
                        onClick={() => dispatch({ type: "PREV_STEP" })}
                        disabled={currentStep === 0 || creating}
                        style={{
                            padding: "8px 16px",
                            fontSize: "0.8rem",
                            background: "none",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius)",
                            color: currentStep === 0 ? "var(--text-muted)" : "var(--text)",
                            cursor: currentStep === 0 || creating ? "not-allowed" : "pointer",
                            opacity: currentStep === 0 ? 0.4 : 1,
                        }}
                    >
                        Back
                    </button>
                    <button
                        onClick={() => dispatch({ type: "NEXT_STEP" })}
                        disabled={!canProceedFromStep[currentStep] || creating}
                        className="btn-primary"
                        style={{
                            padding: "8px 20px",
                            fontSize: "0.8rem",
                            width: "auto",
                            opacity: canProceedFromStep[currentStep] ? 1 : 0.5,
                        }}
                    >
                        Next
                    </button>
                </div>
            )}
        </div>
    )
}
