"use client"

import { useMode } from "@/context/ModeContext"
import { explorerTxUrl } from "@/lib/relayer"

type Phase = "signup" | "voting" | "closed"
type VoteStep = "idle" | "fetching-signup-group" | "generating-join-proof" | "submitting-join" | "fetching-voting-group" | "generating-vote-proof" | "encrypting" | "submitting-vote" | "timing-delay" | "verifying" | "done" | "error"

interface VotingSectionProps {
    phase: Phase
    gaslessEnabled: boolean
    address: string | null
    identity: any | null
    optionLabels: string[]
    selectedVote: number | null
    setSelectedVote: (v: number | null) => void
    voteStep: VoteStep
    stepMsg: string
    stepInfo: { step: number; total: number; label: string } | null
    isProcessing: boolean
    canVote: boolean
    txHash: string
    error: string
    onChainVerified: boolean | null
    joinStatus: "unknown" | "checking" | "joined" | "not-joined"
    handleJoinAndVote: () => void
    setVoteStep: (v: VoteStep) => void
    setSelectedVote_reset: () => void
    setTxHash: (v: string) => void
    setError: (v: string) => void
}

export default function VotingSection({
    phase, gaslessEnabled, address, identity,
    optionLabels, selectedVote, setSelectedVote,
    voteStep, stepMsg, stepInfo, isProcessing, canVote,
    txHash, error, onChainVerified, joinStatus,
    handleJoinAndVote, setVoteStep, setTxHash, setError,
}: VotingSectionProps) {
    const { isSimple } = useMode()

    return (
        <>
            {/* ── VOTING PHASE ── */}
            {phase === "voting" && identity && (gaslessEnabled || address) && (
                <>
                    {/* Join + vote status indicators */}
                    {voteStep === "idle" && joinStatus === "joined" && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)", background: "var(--success-bg)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontSize: "1.2rem" }}>&#10003;</span>
                                <div>
                                    <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>
                                        {isSimple ? "You\u2019re ready to vote" : "Anonymously joined"}
                                    </p>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                        {isSimple
                                            ? "Select an option below and cast your vote."
                                            : "Your identity has been separated from your registration. Select an option and cast your vote."}
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {voteStep === "idle" && joinStatus === "not-joined" && (
                        <div className="card" style={{ marginBottom: 16, background: "var(--bg)" }}>
                            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                                {isSimple
                                    ? "When you vote, it will be completely anonymous. No one can see how you voted."
                                    : gaslessEnabled
                                        ? "When you vote, your identity is cryptographically separated from your registration so nobody can link your signup to your vote. Everything is handled automatically."
                                        : "When you vote, your identity is cryptographically separated from your registration so nobody can link your signup to your vote. This requires two wallet confirmations."}
                            </p>
                        </div>
                    )}

                    {/* Vote options */}
                    <div className="card" style={{ marginBottom: 16 }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
                            {optionLabels.map((label, i) => (
                                <div
                                    key={i}
                                    className={`vote-option ${selectedVote === i ? "selected" : ""}`}
                                    onClick={() => !isProcessing && setSelectedVote(i)}
                                    style={{
                                        opacity: isProcessing ? 0.4 : 1,
                                        cursor: isProcessing ? "not-allowed" : "pointer",
                                        flex: "1 1 calc(50% - 6px)",
                                        minWidth: 120,
                                    }}
                                >
                                    {label}
                                </div>
                            ))}
                        </div>

                        {/* Processing indicator */}
                        {isProcessing && (
                            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: 14, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                                <div className="spinner" />
                                <div>
                                    <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                                        {stepInfo ? `Step ${stepInfo.step} of ${stepInfo.total}: ${stepInfo.label}` : stepMsg}
                                    </p>
                                    {!isSimple && (
                                        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                            {(voteStep === "generating-join-proof" || voteStep === "generating-vote-proof") && "This runs entirely in your browser"}
                                            {voteStep === "timing-delay" && "Random delay protects your identity"}
                                            {voteStep === "verifying" && "Independently checking the blockchain"}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {voteStep === "done" && txHash && (
                            <div style={{ marginBottom: 16, padding: 14, background: "var(--success-bg-light)", borderRadius: "var(--radius)", border: "1px solid var(--success-border)" }}>
                                <p style={{ color: "var(--success)", fontWeight: 600, marginBottom: isSimple ? 0 : 4 }}>
                                    Vote submitted anonymously!
                                    {gaslessEnabled && onChainVerified === true && " \u2713 Verified on-chain"}
                                </p>
                                {gaslessEnabled && onChainVerified === false && (
                                    <p style={{ color: "var(--warning)", fontSize: "0.8rem", marginBottom: 6 }}>
                                        \u26a0 Could not verify your vote on-chain. Try refreshing the page in a few minutes to check. If the issue persists, contact the election admin.
                                    </p>
                                )}
                                {!isSimple && (
                                    <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.75rem" }}>
                                        View on Etherscan &rarr;
                                    </a>
                                )}
                            </div>
                        )}

                        {voteStep === "error" && (
                            <div style={{ marginBottom: 16, padding: 14, background: "var(--error-bg)", borderRadius: "var(--radius)", border: "1px solid var(--error-border)" }}>
                                <p style={{ color: "var(--error)", fontWeight: 600, marginBottom: 4 }}>Failed</p>
                                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{error}</p>
                            </div>
                        )}

                        <button
                            className="btn-primary"
                            onClick={handleJoinAndVote}
                            disabled={!canVote || selectedVote === null || isProcessing}
                        >
                            {isProcessing ? "Processing..." : voteStep === "done" ? "Vote Submitted!" : "Vote"}
                        </button>

                        {voteStep === "error" && (
                            <button className="btn-secondary" onClick={() => { setVoteStep("idle"); setSelectedVote(null); setTxHash(""); setError("") }} style={{ marginTop: 8 }}>
                                Try Again
                            </button>
                        )}
                    </div>
                </>
            )}

            {/* CLOSED phase message */}
            {phase === "closed" && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "12px 0" }}>
                        Voting is closed. Check the Results tab.
                    </p>
                </div>
            )}
        </>
    )
}
