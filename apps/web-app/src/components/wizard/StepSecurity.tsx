"use client"

import { ElectionFormState, ElectionFormDispatch } from "@/hooks/useElectionForm"
import { isAddress } from "ethers"
import TrustCallout from "@/components/TrustCallout"

interface Props {
    state: ElectionFormState
    dispatch: ElectionFormDispatch
}

export default function StepSecurity({ state, dispatch }: Props) {
    const { encryptionMode, committeeMembers, threshold, creating } = state

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Encryption mode selector */}
            <div>
                <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                    Results security
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                    <div
                        onClick={() => !creating && dispatch({ type: "SET_ENCRYPTION_MODE", mode: "single" })}
                        style={{
                            flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
                            border: `1px solid ${encryptionMode === "single" ? "var(--accent)" : "var(--border)"}`,
                            background: encryptionMode === "single" ? "var(--accent-bg)" : "var(--bg)",
                        }}
                    >
                        <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Only you</span>
                        <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>You control when results are revealed</p>
                    </div>
                    <div
                        onClick={() => !creating && dispatch({ type: "SET_ENCRYPTION_MODE", mode: "threshold" })}
                        style={{
                            flex: 1, padding: "10px 14px", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
                            border: `1px solid ${encryptionMode === "threshold" ? "var(--accent)" : "var(--border)"}`,
                            background: encryptionMode === "threshold" ? "var(--accent-bg)" : "var(--bg)",
                        }}
                    >
                        <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Committee</span>
                        <p style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginTop: 2 }}>Multiple members must agree to reveal results</p>
                    </div>
                </div>
                <TrustCallout
                    text={encryptionMode === "single"
                        ? "Election key stored in this browser\u2019s localStorage. You alone control when results are revealed. You can back up the key from the Results tab."
                        : `Key split via Shamir secret sharing. ${threshold}-of-${committeeMembers.length} members must cooperate to decrypt results. No single member can reveal votes alone.`}
                    variant="info"
                />
            </div>

            {/* Committee setup (threshold mode) */}
            {encryptionMode === "threshold" && (
                <div style={{ padding: "12px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Committee ({committeeMembers.length} members)
                        </label>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <label style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Threshold:</label>
                            <select
                                value={threshold}
                                onChange={e => dispatch({ type: "SET_FIELD", field: "threshold", value: Number(e.target.value) })}
                                disabled={creating}
                                style={{ padding: "4px 8px", fontSize: "0.8rem", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
                            >
                                {Array.from({ length: committeeMembers.length - 1 }, (_, i) => i + 2).map(t => (
                                    <option key={t} value={t}>{t} of {committeeMembers.length}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.4 }}>
                        Each member generates their own key on the election page. No private keys are shared.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {committeeMembers.map((m, i) => (
                            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", background: "var(--card)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", width: 16 }}>{i + 1}</span>
                                    <input
                                        type="text" placeholder="Name"
                                        value={m.name} onChange={e => dispatch({ type: "UPDATE_COMMITTEE_MEMBER", index: i, field: "name", value: e.target.value })}
                                        disabled={creating} style={{ flex: 1, padding: "6px 10px", fontSize: "0.8rem" }}
                                    />
                                    {committeeMembers.length > 2 && (
                                        <button onClick={() => dispatch({ type: "REMOVE_COMMITTEE_MEMBER", index: i })} disabled={creating}
                                            style={{ background: "none", border: "none", color: "var(--error)", fontSize: "1rem", cursor: "pointer", padding: "0 4px" }}>×</button>
                                    )}
                                </div>
                                <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 22 }}>
                                    <input
                                        type="text" placeholder="Wallet address (0x...)"
                                        value={m.address} onChange={e => dispatch({ type: "UPDATE_COMMITTEE_MEMBER", index: i, field: "address", value: e.target.value })}
                                        disabled={creating} className="mono"
                                        style={{ flex: 1, padding: "6px 10px", fontSize: "0.75rem", minWidth: 0 }}
                                    />
                                </div>
                                {m.address && !isAddress(m.address.trim()) && (
                                    <p style={{ marginLeft: 22, fontSize: "0.65rem", color: "var(--error)" }}>Invalid Ethereum address</p>
                                )}
                            </div>
                        ))}
                    </div>
                    {committeeMembers.length < 10 && (
                        <button onClick={() => dispatch({ type: "ADD_COMMITTEE_MEMBER" })} disabled={creating}
                            style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.75rem", cursor: "pointer", padding: "6px 0", marginTop: 4 }}>
                            + Add member
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
