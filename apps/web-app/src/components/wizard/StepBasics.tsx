"use client"

import { ElectionFormState, ElectionFormDispatch } from "@/hooks/useElectionForm"

interface Props {
    state: ElectionFormState
    dispatch: ElectionFormDispatch
}

export default function StepBasics({ state, dispatch }: Props) {
    const { electionTitle, optionLabels, signupHours, votingHours, creating } = state

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
                <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                    Election title
                </label>
                <input
                    type="text"
                    placeholder='What are you voting on? (e.g. "Approve Q1 Budget")'
                    value={electionTitle}
                    onChange={e => dispatch({ type: "SET_FIELD", field: "electionTitle", value: e.target.value })}
                    disabled={creating}
                    autoFocus
                />
            </div>

            {/* Vote options */}
            <div>
                <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                    Vote Options ({optionLabels.length})
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {optionLabels.map((label, i) => (
                        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", width: 20, textAlign: "center" }}>{i}</span>
                            <input
                                type="text"
                                placeholder={`Option ${i} label`}
                                value={label}
                                onChange={e => dispatch({ type: "UPDATE_OPTION", index: i, value: e.target.value })}
                                disabled={creating}
                                style={{ flex: 1 }}
                            />
                            {optionLabels.length > 2 && (
                                <button
                                    onClick={() => dispatch({ type: "REMOVE_OPTION", index: i })}
                                    disabled={creating}
                                    style={{ background: "none", border: "none", color: "var(--error)", fontSize: "1rem", cursor: "pointer", padding: "0 6px" }}
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                {optionLabels.length < 10 && (
                    <button
                        onClick={() => dispatch({ type: "ADD_OPTION" })}
                        disabled={creating}
                        style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.8rem", cursor: "pointer", padding: "6px 0", marginTop: 4 }}
                    >
                        + Add option
                    </button>
                )}
            </div>

            {/* Deadlines */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div style={{ flex: 1 }}>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        Signup duration (hours)
                    </label>
                    <input
                        type="number"
                        placeholder="24"
                        value={signupHours}
                        onChange={e => dispatch({ type: "SET_FIELD", field: "signupHours", value: e.target.value })}
                        disabled={creating}
                    />
                </div>
                <div style={{ flex: 1 }}>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                        Voting duration (hours)
                    </label>
                    <input
                        type="number"
                        placeholder="72"
                        value={votingHours}
                        onChange={e => dispatch({ type: "SET_FIELD", field: "votingHours", value: e.target.value })}
                        disabled={creating}
                    />
                </div>
            </div>
        </div>
    )
}
