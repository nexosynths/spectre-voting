"use client"

import { useMode } from "@/context/ModeContext"
import { EXPLORER_URL } from "@/lib/contracts"

type Phase = "signup" | "voting" | "closed"
type TallyStep = "idle" | "fetching" | "decrypting" | "done" | "error"

interface DecryptedVote {
    nullifierHash: string
    vote: bigint
    weight: bigint
    voteRandomness: bigint
    commitmentValid: boolean
}

interface TallyResult {
    optionCounts: number[]
    totalValid: number
    totalInvalid: number
    duplicatesRemoved: number
    decryptedVotes: DecryptedVote[]
}

interface CommitteeState {
    threshold: number
    members: string[]
    registeredKeyCount: number
    finalized: boolean
    submittedShareCount: number
    memberPubKeys: { [addr: string]: string }
    memberHasSubmittedShare: { [addr: string]: boolean }
}

interface ResultsTabProps {
    phase: Phase
    state: { voteCount: number; selfSignupAllowed: boolean }
    optionLabels: string[]
    isAdmin: boolean
    isOnChainCommittee: boolean
    isThresholdElection: boolean
    committeeState: CommitteeState | null
    committeeSharesReady: boolean
    thresholdMeta: any | null
    hasStoredKey: boolean
    electionKeyHex: string
    tallyStep: TallyStep
    tallyMsg: string
    tallyResult: TallyResult | null
    tallyError: string
    manualKeyInput: string
    setManualKeyInput: (v: string) => void
    // Legacy threshold UI
    selectedMemberIdx: number
    setSelectedMemberIdx: (v: number) => void
    decryptShareInput: string
    setDecryptShareInput: (v: string) => void
    decryptKeyInput: string
    setDecryptKeyInput: (v: string) => void
    decryptedShareResult: string
    decryptShareError: string
    handleDecryptShare: () => void
    thresholdShareInputs: string[]
    setThresholdShareInputs: (v: string[]) => void
    // Tally actions
    runTally: (manualKey?: string) => void
    runThresholdTally: () => void
    runOnChainCommitteeTally: () => void
    setTallyResult: (v: TallyResult | null) => void
    setTallyStep: (v: TallyStep) => void
    // Commit tally
    onChainTally: { committed: boolean; poseidonCommitment: string; totalValid: number; totalInvalid: number; optionCounts: number[] } | null
    commitStep: "idle" | "submitting" | "done" | "error"
    commitTxHash: string
    commitError: string
    handleCommitTally: () => void
    copyToClipboard: (text: string, label: string) => void
    copied: string
}

export default function ResultsTab({
    phase, state, optionLabels, isAdmin,
    isOnChainCommittee, isThresholdElection,
    committeeState, committeeSharesReady, thresholdMeta, hasStoredKey, electionKeyHex,
    tallyStep, tallyMsg, tallyResult, tallyError,
    manualKeyInput, setManualKeyInput,
    selectedMemberIdx, setSelectedMemberIdx,
    decryptShareInput, setDecryptShareInput,
    decryptKeyInput, setDecryptKeyInput,
    decryptedShareResult, decryptShareError, handleDecryptShare,
    thresholdShareInputs, setThresholdShareInputs,
    runTally, runThresholdTally, runOnChainCommitteeTally,
    setTallyResult, setTallyStep,
    onChainTally, commitStep, commitTxHash, commitError, handleCommitTally,
    copyToClipboard, copied,
}: ResultsTabProps) {
    const { isSimple, isAdvanced } = useMode()

    return (
        <>
            {!tallyResult && tallyStep !== "done" && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>
                        {isSimple ? "Count Votes" : "Decrypt & Tally"}
                    </h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 14 }}>
                        {phase !== "closed"
                            ? isSimple
                                ? "Voting is still open. You can preview current results."
                                : "Election is still active. You can preview interim results."
                            : isSimple
                                ? "Voting is closed. Count the votes to see the final result."
                                : "Voting is closed. Decrypt all votes to see the final result."}
                    </p>

                    {isOnChainCommittee && committeeState ? (
                        /* ── ON-CHAIN COMMITTEE TALLY UI ── */
                        <>
                            <div style={{ padding: "10px 14px", background: "var(--purple-bg-light)", borderRadius: "var(--radius)", border: "1px solid var(--purple-border)", marginBottom: 14 }}>
                                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--purple)" }}>
                                    {isSimple
                                        ? committeeSharesReady
                                            ? "Results are ready!"
                                            : `Waiting for organizers to publish results (${committeeState.submittedShareCount} of ${committeeState.threshold} ready)`
                                        : <>
                                            Committee Election &mdash; {committeeState.submittedShareCount} of {committeeState.threshold} shares submitted
                                            {committeeSharesReady && <span style={{ color: "var(--success)" }}> &mdash; ready to tally!</span>}
                                        </>}
                                </span>
                            </div>
                            {!committeeSharesReady && !isSimple && (
                                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
                                    Waiting for committee members to submit their decrypted shares on the Committee tab.
                                    Need {committeeState.threshold - committeeState.submittedShareCount} more share(s).
                                </p>
                            )}
                        </>
                    ) : isAdvanced && isThresholdElection && thresholdMeta ? (
                        /* ── LEGACY THRESHOLD TALLY UI (hidden in Simple mode) ── */
                        <>
                            <div style={{ padding: "10px 14px", background: "var(--purple-bg-light)", borderRadius: "var(--radius)", border: "1px solid var(--purple-border)", marginBottom: 14 }}>
                                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--purple)" }}>
                                    Threshold Election &mdash; {thresholdMeta.threshold} of {thresholdMeta.totalShares} shares needed
                                </span>
                            </div>

                            {/* Section A: Decrypt Your Share */}
                            <details style={{ marginBottom: 14 }}>
                                <summary style={{ fontSize: "0.85rem", fontWeight: 600, cursor: "pointer", marginBottom: 8 }}>
                                    Decrypt Your Share (committee members)
                                </summary>
                                <div style={{ padding: "12px 14px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                    <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
                                        Select your name, then paste the private key you saved during election setup.
                                    </p>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
                                        <select
                                            value={selectedMemberIdx}
                                            onChange={e => {
                                                const idx = Number(e.target.value)
                                                setSelectedMemberIdx(idx)
                                                if (idx >= 0 && thresholdMeta!.encryptedShares[idx]) {
                                                    setDecryptShareInput(thresholdMeta!.encryptedShares[idx].encryptedDataHex)
                                                } else {
                                                    setDecryptShareInput("")
                                                }
                                            }}
                                            style={{ fontSize: "0.8rem", padding: "8px 10px" }}
                                        >
                                            <option value={-1}>I am...</option>
                                            {thresholdMeta!.committee.map((m: any, i: number) => (
                                                <option key={i} value={i}>{m.id || m.name}</option>
                                            ))}
                                        </select>
                                        <input
                                            placeholder="Your personal private key (64 hex chars)"
                                            value={decryptKeyInput}
                                            onChange={e => setDecryptKeyInput(e.target.value)}
                                            className="mono" style={{ fontSize: "0.7rem" }}
                                            type="password"
                                        />
                                    </div>
                                    <button className="btn-primary" onClick={handleDecryptShare}
                                        disabled={selectedMemberIdx < 0 || !decryptShareInput.trim() || !decryptKeyInput.trim()}
                                        style={{ marginBottom: 8 }}>
                                        Decrypt My Share
                                    </button>
                                    {decryptedShareResult && (
                                        <div style={{ padding: "8px 12px", background: "var(--success-bg-light)", borderRadius: 8, border: "1px solid var(--success-border)" }}>
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                                <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--success)" }}>Decrypted share:</span>
                                                <button onClick={() => { navigator.clipboard.writeText(decryptedShareResult) }}
                                                    style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}>Copy</button>
                                            </div>
                                            <code className="mono" style={{ fontSize: "0.65rem", color: "var(--text-muted)", wordBreak: "break-all", display: "block" }}>
                                                {decryptedShareResult}
                                            </code>
                                        </div>
                                    )}
                                    {decryptShareError && (
                                        <p style={{ fontSize: "0.75rem", color: "var(--error)", marginTop: 4 }}>{decryptShareError}</p>
                                    )}
                                </div>
                            </details>

                            {/* Section B: Collect Shares */}
                            <div style={{ marginBottom: 14 }}>
                                <h4 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: 8 }}>Collect Decrypted Shares</h4>
                                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                                    {thresholdMeta.committee.map((m: any, i: number) => (
                                        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", width: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>
                                                {m.id || m.name}
                                            </span>
                                            <input
                                                placeholder="Decrypted share (128 hex chars)"
                                                value={thresholdShareInputs[i] || ""}
                                                onChange={e => {
                                                    const next = [...thresholdShareInputs]
                                                    next[i] = e.target.value
                                                    setThresholdShareInputs(next)
                                                }}
                                                className="mono" style={{ flex: 1, fontSize: "0.7rem", padding: "6px 8px", minWidth: 0 }}
                                            />
                                            {thresholdShareInputs[i]?.trim().length === 128 && (
                                                <span style={{ color: "var(--success)", fontSize: "0.8rem", flexShrink: 0 }}>&#10003;</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 10 }}>
                                    {thresholdShareInputs.filter(s => s.trim().length === 128).length} of {thresholdMeta.totalShares} shares collected
                                    ({thresholdMeta.threshold} needed)
                                    {thresholdShareInputs.filter(s => s.trim().length === 128).length >= thresholdMeta.threshold && (
                                        <span style={{ color: "var(--success)", fontWeight: 600 }}> &mdash; ready!</span>
                                    )}
                                </p>
                            </div>
                        </>
                    ) : !isAdmin && !hasStoredKey ? (
                        /* ── NON-ADMIN WITHOUT KEY — show waiting message ── */
                        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
                            {onChainTally?.committed
                                ? isSimple
                                    ? "The results have been published below."
                                    : "The admin has published verified results below."
                                : isSimple
                                    ? "Results will appear here once the organizer publishes them."
                                    : "Results will be available once the election admin publishes them."}
                        </p>
                    ) : (
                        /* ── SINGLE KEY TALLY UI (admin or key holder) ── */
                        <>
                            {hasStoredKey ? (
                                <div style={{ marginBottom: 12 }}>
                                    <p style={{ fontSize: "0.8rem", color: "var(--success)", marginBottom: isAdvanced ? 8 : 0 }}>
                                        {isSimple ? "Ready to count votes" : "Election key found in this browser"}
                                    </p>
                                    {isAdvanced && (
                                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                            <code className="mono" style={{ flex: 1, background: "var(--bg)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.65rem" }}>
                                                {electionKeyHex}
                                            </code>
                                            <button
                                                onClick={() => copyToClipboard(electionKeyHex, "election-key")}
                                                className="btn-secondary"
                                                style={{ width: "auto", padding: "8px 12px", fontSize: "0.7rem" }}
                                            >
                                                {copied === "election-key" ? "Copied!" : "Copy Key"}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ) : isAdvanced ? (
                                <div style={{ marginBottom: 12 }}>
                                    <p style={{ fontSize: "0.8rem", color: "var(--warning)", marginBottom: 8 }}>
                                        No election key found. Paste the key from the browser that created this election:
                                    </p>
                                    <input
                                        placeholder="Election private key (64 hex chars)"
                                        value={manualKeyInput}
                                        onChange={e => setManualKeyInput(e.target.value)}
                                        style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "0.75rem" }}
                                    />
                                </div>
                            ) : null}
                        </>
                    )}

                    {tallyStep !== "idle" && tallyStep !== "error" && (
                        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: 14, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                            <div className="spinner" />
                            <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>{tallyMsg}</p>
                        </div>
                    )}

                    {tallyStep === "error" && (
                        <div style={{ marginBottom: 16, padding: 14, background: "var(--error-bg)", borderRadius: "var(--radius)", border: "1px solid var(--error-border)" }}>
                            <p style={{ color: "var(--error)", fontWeight: 600, marginBottom: 4 }}>Tally Failed</p>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{tallyError}</p>
                        </div>
                    )}

                    {/* Hide tally button for non-admin voters without a key */}
                    {(isAdmin || hasStoredKey || isOnChainCommittee || isThresholdElection) && (
                    <button
                        className="btn-primary"
                        onClick={() =>
                            isOnChainCommittee ? runOnChainCommitteeTally() :
                            isThresholdElection ? runThresholdTally() :
                            runTally(manualKeyInput || undefined)
                        }
                        disabled={
                            tallyStep === "fetching" || tallyStep === "decrypting" ||
                            (isOnChainCommittee
                                ? !committeeSharesReady
                                : isThresholdElection
                                ? (thresholdShareInputs.filter(s => s.trim().length === 128).length < (thresholdMeta?.threshold || 2))
                                : (!hasStoredKey && !manualKeyInput.trim()))
                        }
                    >
                        {tallyStep === "fetching" || tallyStep === "decrypting"
                            ? "Computing..."
                            : isSimple ? "Count Votes" : "Tally Votes"}
                    </button>
                    )}
                </div>
            )}

            {tallyResult && (
                <>
                    <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
                        <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                            {phase === "closed" ? "Final Results" : "Interim Results"}
                        </h4>

                        {tallyResult.totalValid === 0 ? (
                            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", padding: "20px 0" }}>No valid votes</p>
                        ) : (
                            <>
                                {/* Per-option bars */}
                                <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
                                    {tallyResult.optionCounts.map((count: number, i: number) => {
                                        const pct = (count / tallyResult.totalValid) * 100
                                        const colors = ["var(--success)", "var(--error)", "var(--accent)", "var(--warning)", "var(--purple)", "var(--cyan)", "var(--orange)", "var(--pink)"]
                                        const color = colors[i % colors.length]
                                        return (
                                            <div key={i}>
                                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                                                    <span style={{ fontSize: "0.85rem", fontWeight: 600, color }}>{optionLabels[i]}</span>
                                                    <span style={{ fontSize: "1.1rem", fontWeight: 800, color }}>{count}</span>
                                                </div>
                                                <div style={{ height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden" }}>
                                                    <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4, transition: "width 0.5s ease" }} />
                                                </div>
                                                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2, textAlign: "right" }}>
                                                    {pct.toFixed(1)}%
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>

                                {/* Winner announcement */}
                                {phase === "closed" && (() => {
                                    const maxCount = Math.max(...tallyResult.optionCounts)
                                    const winners = tallyResult.optionCounts.reduce((acc: number[], c: number, i: number) => c === maxCount ? [...acc, i] : acc, [])
                                    if (winners.length === 1) {
                                        const colors = ["var(--success)", "var(--error)", "var(--accent)", "var(--warning)", "var(--purple)", "var(--cyan)", "var(--orange)", "var(--pink)"]
                                        return (
                                            <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 12 }}>
                                                <span style={{ fontWeight: 700, color: colors[winners[0] % colors.length] }}>
                                                    {optionLabels[winners[0]]} wins
                                                </span>
                                            </div>
                                        )
                                    } else if (winners.length > 1 && tallyResult.totalValid > 0) {
                                        return (
                                            <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: "var(--bg-hover)", border: "1px solid var(--border)", marginBottom: 12 }}>
                                                <span style={{ fontWeight: 700, color: "var(--warning)" }}>Tie</span>
                                            </div>
                                        )
                                    }
                                    return null
                                })()}
                            </>
                        )}
                    </div>

                    {/* Audit stats — Advanced only */}
                    {isAdvanced && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Audit</h4>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: "0.85rem" }}>
                                <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Valid</div>
                                    <div style={{ fontWeight: 700, color: "var(--success)" }}>{tallyResult.totalValid}</div>
                                </div>
                                <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Invalid</div>
                                    <div style={{ fontWeight: 700, color: tallyResult.totalInvalid > 0 ? "var(--error)" : "var(--text-muted)" }}>{tallyResult.totalInvalid}</div>
                                </div>
                                <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Duplicates Removed</div>
                                    <div style={{ fontWeight: 700 }}>{tallyResult.duplicatesRemoved}</div>
                                </div>
                                <div style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>On-chain Total</div>
                                    <div style={{ fontWeight: 700 }}>{state.voteCount}</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Detailed vote list — Advanced only */}
                    {isAdvanced && tallyResult.decryptedVotes.length > 0 && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                                Votes ({tallyResult.decryptedVotes.length})
                            </h4>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {tallyResult.decryptedVotes.map((dv, i) => (
                                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", fontSize: "0.8rem" }}>
                                        <span className="mono" style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                                            {dv.nullifierHash.slice(0, 10)}...{dv.nullifierHash.slice(-6)}
                                        </span>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            {dv.commitmentValid ? (
                                                <>
                                                    <span style={{ fontWeight: 700, fontSize: "0.75rem" }}>
                                                        {optionLabels[Number(dv.vote)] || `Option ${dv.vote}`}
                                                    </span>
                                                    <span style={{ fontSize: "0.65rem", color: "var(--success)" }}>{"\u2713"}</span>
                                                </>
                                            ) : (
                                                <span style={{ fontWeight: 700, fontSize: "0.75rem", color: "var(--error)" }}>INVALID</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <button className="btn-secondary" onClick={() => { setTallyResult(null); setTallyStep("idle") }} style={{ marginBottom: 16 }}>
                        Re-tally
                    </button>

                    {/* Commit tally on-chain (admin only, after tally computed, voting closed, not yet committed) */}
                    {isAdmin && phase === "closed" && !onChainTally?.committed && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>
                                {isSimple ? "Publish Results" : "Commit Results On-Chain"}
                            </h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                {isSimple
                                    ? "Publish the final results. Once published, they can\u2019t be changed."
                                    : "Publish the tally permanently on-chain with a Poseidon commitment hash. Anyone can verify by recomputing the hash from the stored data. This action is irreversible."}
                            </p>
                            {commitStep === "submitting" && (
                                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                                    <div className="spinner" />
                                    <p style={{ fontSize: "0.85rem" }}>Confirm in wallet...</p>
                                </div>
                            )}
                            {commitStep === "done" && commitTxHash && (
                                <div style={{ marginBottom: 12, padding: 12, background: "var(--success-bg-light)", borderRadius: "var(--radius)", border: "1px solid var(--success-border)" }}>
                                    <p style={{ color: "var(--success)", fontWeight: 600, marginBottom: isSimple ? 0 : 4 }}>Tally committed!</p>
                                    {!isSimple && (
                                        <a href={`${EXPLORER_URL}/tx/${commitTxHash}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.75rem" }}>
                                            View on Basescan
                                        </a>
                                    )}
                                </div>
                            )}
                            {commitStep === "error" && commitError && (
                                <div style={{ marginBottom: 12, padding: 12, background: "var(--error-bg)", borderRadius: "var(--radius)", border: "1px solid var(--error-border)" }}>
                                    <p style={{ color: "var(--error)", fontWeight: 600 }}>{commitError}</p>
                                </div>
                            )}
                            <button className="btn-primary" onClick={handleCommitTally}
                                disabled={commitStep === "submitting"}>
                                {commitStep === "submitting" ? "Committing..." : isSimple ? "Publish Results" : "Commit Tally On-Chain"}
                            </button>
                        </div>
                    )}
                </>
            )}

            {/* On-chain commitment display — Advanced only */}
            {isAdvanced && onChainTally?.committed && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)" }}>
                    <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                        On-Chain Commitment
                    </h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: "0.8rem" }}>
                        <div style={{ padding: "8px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Poseidon Commitment</div>
                            <code className="mono" style={{ fontSize: "0.65rem", wordBreak: "break-all" }}>
                                {onChainTally.poseidonCommitment}
                            </code>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <div style={{ padding: "8px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 2 }}>Valid</div>
                                <div style={{ fontWeight: 700 }}>{onChainTally.totalValid}</div>
                            </div>
                            <div style={{ padding: "8px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 2 }}>Invalid</div>
                                <div style={{ fontWeight: 700 }}>{onChainTally.totalInvalid}</div>
                            </div>
                        </div>
                        {onChainTally.optionCounts.map((count, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                <span>{optionLabels[i] || `Option ${i}`}</span>
                                <span style={{ fontWeight: 700 }}>{count}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Simple mode: show committed confirmation */}
            {isSimple && onChainTally?.committed && !tallyResult && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)", background: "var(--success-bg)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: "1.2rem", color: "var(--success)" }}>&#10003;</span>
                        <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--success)" }}>Results have been published and verified.</p>
                    </div>
                </div>
            )}
        </>
    )
}
