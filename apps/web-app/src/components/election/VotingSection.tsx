"use client"

/**
 * What the voter's browser found on-chain for its latest ballot: still checking, landed
 * exactly as sent, landed with different contents, or not found after several minutes.
 */
export type BallotCheck = "pending" | "confirmed" | "altered" | "missing" | null

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
    deadlinePassed: boolean
    unsealAt: number
    txHash: string
    error: string
    ballotCheck: BallotCheck
    /** Whether the latest submission changed an earlier vote */
    submittedChange: boolean
    /** Weighted election: an unusual weight is visible at signup and in the opened ballot */
    weighted: boolean
    /** Token-gated election: the relay saw the voter's wallet at signup */
    tokenGated: boolean
    joinStatus: "unknown" | "checking" | "joined" | "not-joined"
    handleJoinAndVote: () => void
    setVoteStep: (v: VoteStep) => void
    setSelectedVote_reset: () => void
    setTxHash: (v: string) => void
    setError: (v: string) => void
    hasVotedBefore: boolean
    voteVersion: number
    maxOverwrites: number
}

export default function VotingSection({
    phase, gaslessEnabled, address, identity,
    optionLabels, selectedVote, setSelectedVote,
    voteStep, stepMsg, stepInfo, isProcessing, canVote, deadlinePassed, unsealAt,
    txHash, error, ballotCheck, submittedChange, weighted, tokenGated, joinStatus,
    handleJoinAndVote, setVoteStep, setTxHash, setError,
    hasVotedBefore, voteVersion, maxOverwrites,
}: VotingSectionProps) {
    const changesRemaining = maxOverwrites + 1 - voteVersion  // 6 total - used
    const canOverwrite = changesRemaining > 0
    return (
        <>
            {/* ── VOTING PHASE ── */}
            {/* Deadline passed: ballots can't be cast any more */}
            {phase === "voting" && deadlinePassed && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "12px 0" }}>
                        The voting deadline has passed. {unsealAt > 0 && Date.now() / 1000 < unsealAt
                            ? `Ballots unseal at ${new Date(unsealAt * 1000).toLocaleTimeString()}; then anyone can count them on the Results tab.`
                            : "Anyone can count the votes on the Results tab."}
                    </p>
                </div>
            )}

            {phase === "voting" && !deadlinePassed && identity && (gaslessEnabled || address) && (
                <>
                    {/* Join + vote status indicators */}
                    {voteStep === "idle" && joinStatus === "joined" && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)", background: "var(--success-bg)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ fontSize: "1.2rem" }}>&#10003;</span>
                                <div>
                                    <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>
                                        Anonymously joined
                                    </p>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                        Your identity has been separated from your registration. Select an option and cast your vote.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {voteStep === "idle" && joinStatus === "not-joined" && (
                        <div className="card" style={{ marginBottom: 16, background: "var(--bg)" }}>
                            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                                When you vote, a zero-knowledge proof separates your vote from your signup, and the relay
                                submits both steps instead of your wallet, so the chain doesn&apos;t record which signup
                                cast which ballot{weighted ? ". In this weighted election, though, your weight is public at signup and in your opened ballot, so an unusual weight can link the two" : ""}.
                                Your ballot is sealed until {unsealAt > 0 ? new Date(unsealAt * 1000).toLocaleString() : "after the voting deadline"}:
                                nobody, including the organizer, can read it before then. After that, every ballot is public.
                                <br /><br />
                                The relay operator sees your IP address when you sign up and when you vote, and in gated
                                elections it saw your {tokenGated ? "wallet" : "code, email or account"} at signup. Your browser also reads the chain
                                through a public RPC service, which sees your IP address and when you check. Once ballots are
                                public, either could match you to your vote. If that matters to you, vote from a different
                                network than the one you signed up from (for example a VPN or Tor).
                            </p>
                        </div>
                    )}

                    {/* Vote overwrite notice */}
                    {voteStep === "idle" && hasVotedBefore && canOverwrite && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)", background: "var(--bg)" }}>
                            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
                                You&apos;ve already voted. You can change your vote: your most recent valid ballot counts.
                                <span style={{ color: "var(--accent)", fontWeight: 600 }}> {changesRemaining} change{changesRemaining !== 1 ? "s" : ""} remaining.</span>
                            </p>
                        </div>
                    )}

                    {voteStep === "idle" && hasVotedBefore && !canOverwrite && (
                        <div className="card" style={{ marginBottom: 16, borderColor: "var(--error-border)", background: "var(--error-bg)" }}>
                            <p style={{ fontSize: "0.85rem", color: "var(--error)", lineHeight: 1.5 }}>
                                Maximum vote changes reached. Your most recent valid ballot counts.
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
                                    <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                                        {(voteStep === "generating-join-proof" || voteStep === "generating-vote-proof") && "This runs entirely in your browser"}
                                        {voteStep === "submitting-join" && "This separates your vote from your signup"}
                                        {voteStep === "encrypting" && "Time-locked with drand until after the voting deadline"}
                                        {voteStep === "timing-delay" && "Makes your join and vote harder to pair for outside observers (not for the relay)"}
                                        {voteStep === "verifying" && "Comparing what reached the chain with what you sent"}
                                    </p>
                                </div>
                            </div>
                        )}

                        {voteStep === "done" && txHash && (
                            <div style={{ marginBottom: 16, padding: 14, background: "var(--success-bg-light)", borderRadius: "var(--radius)", border: "1px solid var(--success-border)" }}>
                                <p style={{ color: "var(--success)", fontWeight: 600, marginBottom: 4 }}>
                                    {submittedChange ? "New ballot sent" : "Ballot sent"}
                                </p>
                                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                                    {canOverwrite && (
                                        <button className="btn-secondary" onClick={() => { setVoteStep("idle"); setSelectedVote(null); setTxHash(""); setError("") }} style={{ fontSize: "0.75rem", padding: "4px 10px" }}>
                                            Change your vote
                                        </button>
                                    )}
                                </div>
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
                            disabled={!canVote || selectedVote === null || isProcessing || (hasVotedBefore && !canOverwrite)}
                        >
                            {isProcessing
                                ? "Processing..."
                                : voteStep === "done"
                                    ? (submittedChange ? "Vote Changed!" : "Vote Submitted!")
                                    : hasVotedBefore
                                        ? "Change Your Vote"
                                        : "Vote"}
                        </button>

                        {voteStep === "error" && (
                            <button className="btn-secondary" onClick={() => { setVoteStep("idle"); setSelectedVote(null); setTxHash(""); setError("") }} style={{ marginTop: 8 }}>
                                Try Again
                            </button>
                        )}
                    </div>
                </>
            )}

            {/* What this browser found on-chain for its latest ballot */}
            {phase !== "signup" && ballotCheck !== null && !isProcessing && (
                <BallotStatusCard status={ballotCheck} />
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

function BallotStatusCard({ status }: { status: Exclude<BallotCheck, null> }) {
    const styles = {
        pending: { border: "var(--border)", background: "var(--bg)", color: "var(--text-muted)" },
        confirmed: { border: "var(--success-border)", background: "var(--success-bg)", color: "var(--success)" },
        altered: { border: "var(--error-border)", background: "var(--error-bg)", color: "var(--error)" },
        missing: { border: "var(--warning)", background: "var(--bg)", color: "var(--warning)" },
    }[status]
    const text = {
        pending: "Checking the chain for your latest ballot. Your browser looks about a minute after you vote, and again each time you open this page.",
        confirmed: "\u2713 Your latest ballot is on-chain, exactly as you sealed it.",
        altered: "Your latest ballot reached the chain with different contents than the ones you sealed, so it won't count. Your previous valid ballot, if you had one, counts instead. Vote again; if this keeps happening, the relay may be interfering, so tell the organizer.",
        missing: "Your latest ballot hasn't shown up on-chain after several minutes; the relay may not have submitted it. This page checks again each time you open it. To be safe, vote again: only your newest valid ballot counts.",
    }[status]
    return (
        <div className="card" style={{ marginBottom: 16, borderColor: styles.border, background: styles.background }}>
            <p style={{ fontSize: "0.85rem", color: styles.color, lineHeight: 1.5, fontWeight: status === "confirmed" ? 600 : 400 }}>{text}</p>
        </div>
    )
}
