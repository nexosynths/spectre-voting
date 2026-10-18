"use client"

import { EXPLORER_URL } from "@/lib/contracts"
import { commitmentMatches, type RecountResult } from "@/lib/tally"

type Phase = "signup" | "voting" | "closed"
type TallyStep = "idle" | "fetching" | "decrypting" | "done" | "error"

interface OnChainTally {
    committed: boolean
    poseidonCommitment: string
    totalValid: number
    totalInvalid: number
    optionCounts: number[]
}

interface ResultsTabProps {
    phase: Phase
    voteCount: number
    optionLabels: string[]
    isAdmin: boolean
    /** Unix seconds when the deadline's drand round is published and ballots can be opened. */
    unsealAt: number
    nowSec: number
    tallyStep: TallyStep
    tallyMsg: string
    tallyResult: RecountResult | null
    tallyError: string
    runTally: () => void
    resetTally: () => void
    onChainTally: OnChainTally | null
    commitStep: "idle" | "submitting" | "done" | "error"
    commitTxHash: string
    commitError: string
    handleCommitTally: () => void
    canCloseVoting: boolean
    closingVoting: boolean
    handleCloseVoting: () => void
    walletConnected: boolean
}

const COLORS = ["var(--success)", "var(--error)", "var(--accent)", "var(--warning)", "var(--purple)", "var(--cyan)", "var(--orange)", "var(--pink)"]

export default function ResultsTab({
    phase, voteCount, optionLabels, isAdmin, unsealAt, nowSec,
    tallyStep, tallyMsg, tallyResult, tallyError, runTally, resetTally,
    onChainTally, commitStep, commitTxHash, commitError, handleCommitTally,
    canCloseVoting, closingVoting, handleCloseVoting, walletConnected,
}: ResultsTabProps) {
    const sealed = unsealAt > 0 && nowSec < unsealAt
    const busy = tallyStep === "fetching" || tallyStep === "decrypting"
    const matches = onChainTally?.committed && tallyResult ? commitmentMatches(onChainTally, tallyResult) : null

    return (
        <>
            {sealed && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Ballots are sealed</h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                        Every ballot is time-locked with drand until hours after the voting deadline. Nobody, including
                        the organizer, can read any ballot before {new Date(unsealAt * 1000).toLocaleString()}. After that,
                        anyone can open them and count.
                    </p>
                </div>
            )}

            {!sealed && !tallyResult && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Count the votes</h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
                        Anyone can do this. Your browser reads every ballot from the chain, checks it found as many as the
                        contract recorded, opens them with the public drand beacon (verified against drand&apos;s public key),
                        checks each against its on-chain commitment, and counts each voter&apos;s latest valid ballot.
                    </p>

                    {busy && (
                        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: 14, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                            <div className="spinner" />
                            <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>{tallyMsg}</p>
                        </div>
                    )}

                    {tallyStep === "error" && (
                        <div style={{ marginBottom: 16, padding: 14, background: "var(--error-bg)", borderRadius: "var(--radius)", border: "1px solid var(--error-border)" }}>
                            <p style={{ color: "var(--error)", fontWeight: 600, marginBottom: 4 }}>Count failed</p>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{tallyError}</p>
                        </div>
                    )}

                    <button className="btn-primary" onClick={runTally} disabled={busy}>
                        {busy ? "Counting..." : "Count votes"}
                    </button>
                </div>
            )}

            {tallyResult && (
                <>
                    <div className="card" style={{ marginBottom: 16, textAlign: "center" }}>
                        <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                            Results
                        </h4>

                        {tallyResult.totalValid === 0 ? (
                            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", padding: "20px 0" }}>No valid votes</p>
                        ) : (
                            <>
                                <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
                                    {tallyResult.optionCounts.map((count: number, i: number) => {
                                        const pct = (count / tallyResult.totalValid) * 100
                                        const color = COLORS[i % COLORS.length]
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

                                {(() => {
                                    const maxCount = Math.max(...tallyResult.optionCounts)
                                    const winners = tallyResult.optionCounts.reduce((acc: number[], c: number, i: number) => c === maxCount ? [...acc, i] : acc, [])
                                    if (winners.length === 1) {
                                        return (
                                            <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 12 }}>
                                                <span style={{ fontWeight: 700, color: COLORS[winners[0] % COLORS.length] }}>
                                                    {optionLabels[winners[0]]} wins
                                                </span>
                                            </div>
                                        )
                                    }
                                    return (
                                        <div style={{ padding: "10px 16px", borderRadius: "var(--radius)", background: "var(--bg-hover)", border: "1px solid var(--border)", marginBottom: 12 }}>
                                            <span style={{ fontWeight: 700, color: "var(--warning)" }}>Tie</span>
                                        </div>
                                    )
                                })()}
                            </>
                        )}

                        {matches !== null && (
                            <p style={{ fontSize: "0.8rem", fontWeight: 600, color: matches ? "var(--success)" : "var(--error)" }}>
                                {matches
                                    ? "✓ Matches the tally the organizer published on-chain"
                                    : "✗ Doesn't match the tally the organizer published on-chain"}
                            </p>
                        )}
                    </div>

                    <div className="card" style={{ marginBottom: 16 }}>
                        <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Audit</h4>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: "0.85rem" }}>
                            {[
                                { label: "Valid (weighted)", value: tallyResult.totalValid, color: "var(--success)" },
                                { label: "Voters with no valid ballot", value: tallyResult.totalInvalid, color: tallyResult.totalInvalid > 0 ? "var(--error)" : "var(--text-muted)" },
                                { label: "Ballots that didn't open or match", value: tallyResult.invalidSubmissions, color: tallyResult.invalidSubmissions > 0 ? "var(--warning)" : "var(--text-muted)" },
                                { label: "Not counted (voter has a later or other ballot)", value: tallyResult.duplicatesRemoved },
                                { label: "Voters", value: tallyResult.voters },
                                { label: "Ballots on-chain", value: voteCount },
                            ].map(stat => (
                                <div key={stat.label} style={{ padding: "10px 14px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>{stat.label}</div>
                                    <div style={{ fontWeight: 700, color: stat.color }}>{stat.value}</div>
                                </div>
                            ))}
                        </div>
                        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 12, lineHeight: 1.5 }}>
                            Counted every ballot up to block {tallyResult.blockNumber}; the number found matched the contract&apos;s count.{" "}
                            {tallyResult.finalized === true && "The chain has finalized past the deadline, so this count is final."}
                            {tallyResult.finalized === false && "The chain hasn't finalized past the deadline yet (this usually takes 15–30 minutes); count again later before relying on it."}
                            {tallyResult.finalized === null && "Couldn't check whether the chain has finalized past the deadline."}
                        </p>
                    </div>

                    {tallyResult.ballots.length > 0 && (
                        <div className="card" style={{ marginBottom: 16 }}>
                            <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                                Ballots ({tallyResult.ballots.length})
                            </h4>
                            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                Opened ballots are public. Each is listed by an anonymous voter tag, not by who cast it.
                            </p>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {tallyResult.ballots.map((ballot, i) => (
                                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)", fontSize: "0.8rem" }}>
                                        <span className="mono" style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                                            {ballot.baseNullifier.slice(0, 10)}...{ballot.baseNullifier.slice(-6)}
                                        </span>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            {ballot.commitmentValid && ballot.vote >= 0n && ballot.vote < BigInt(optionLabels.length) ? (
                                                <>
                                                    <span style={{ fontWeight: 700, fontSize: "0.75rem" }}>
                                                        {optionLabels[Number(ballot.vote)]}
                                                        {ballot.weight > 1n ? ` ×${ballot.weight}` : ""}
                                                    </span>
                                                    <span style={{ fontSize: "0.65rem", color: "var(--success)" }}>{"✓"}</span>
                                                </>
                                            ) : (
                                                <span title={ballot.problem} style={{ fontWeight: 700, fontSize: "0.75rem", color: "var(--error)" }}>INVALID</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <button className="btn-secondary" onClick={resetTally} style={{ marginBottom: 16 }}>
                        Count again
                    </button>

                    {isAdmin && phase === "closed" && !onChainTally?.committed && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>
                                Publish results on-chain
                            </h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                Records this count permanently with a Poseidon hash. It&apos;s a convenience: anyone can still
                                recount from the ballots and see whether it matches. This can&apos;t be undone.
                            </p>
                            {commitStep === "submitting" && (
                                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                                    <div className="spinner" />
                                    <p style={{ fontSize: "0.85rem" }}>Confirm in wallet...</p>
                                </div>
                            )}
                            {commitStep === "done" && commitTxHash && (
                                <div style={{ marginBottom: 12, padding: 12, background: "var(--success-bg-light)", borderRadius: "var(--radius)", border: "1px solid var(--success-border)" }}>
                                    <p style={{ color: "var(--success)", fontWeight: 600, marginBottom: 4 }}>Results published</p>
                                    <a href={`${EXPLORER_URL}/tx/${commitTxHash}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.75rem" }}>
                                        View on Basescan
                                    </a>
                                </div>
                            )}
                            {commitStep === "error" && commitError && (
                                <div style={{ marginBottom: 12, padding: 12, background: "var(--error-bg)", borderRadius: "var(--radius)", border: "1px solid var(--error-border)" }}>
                                    <p style={{ color: "var(--error)", fontWeight: 600 }}>{commitError}</p>
                                </div>
                            )}
                            <button className="btn-primary" onClick={handleCommitTally} disabled={commitStep === "submitting" || tallyResult.finalized === false}>
                                {commitStep === "submitting" ? "Publishing..." : tallyResult.finalized === false ? "Wait for finality, then count again" : "Publish results on-chain"}
                            </button>
                        </div>
                    )}
                </>
            )}

            {phase === "voting" && canCloseVoting && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 8 }}>Close voting</h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                        The deadline has passed, so no more ballots can be cast. Anyone with a wallet can mark the
                        election closed. The organizer needs this before publishing results on-chain.
                    </p>
                    <button className="btn-secondary" onClick={handleCloseVoting} disabled={closingVoting || !walletConnected}>
                        {!walletConnected ? "Connect a wallet to close voting" : closingVoting ? "Closing..." : "Close voting"}
                    </button>
                </div>
            )}

            {onChainTally?.committed && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)" }}>
                    <h4 style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                        Published on-chain by the organizer
                    </h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: "0.8rem" }}>
                        <div style={{ padding: "8px 12px", background: "var(--bg)", borderRadius: 8, border: "1px solid var(--border)" }}>
                            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 4 }}>Poseidon commitment</div>
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
                        {!tallyResult && (
                            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 4 }}>
                                Count the votes above to check these numbers yourself.
                            </p>
                        )}
                    </div>
                </div>
            )}
        </>
    )
}
