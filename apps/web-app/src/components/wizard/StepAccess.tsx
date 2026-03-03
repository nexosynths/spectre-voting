"use client"

import { ElectionFormState, ElectionFormDispatch } from "@/hooks/useElectionForm"
import GateSelector from "@/components/GateSelector"
import TrustCallout from "@/components/TrustCallout"

interface Props {
    state: ElectionFormState
    dispatch: ElectionFormDispatch
    effectiveGasless: boolean
    gaslessLocked: boolean
    walletForced: boolean
    gaslessForced: boolean
}

export default function StepAccess({ state, dispatch, effectiveGasless, gaslessLocked, walletForced, gaslessForced }: Props) {
    const { gateType, creating, gaslessMode } = state
    const toggleDisabled = creating || gaslessLocked

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <GateSelector
                gateType={gateType}
                setGateType={g => dispatch({ type: "SET_GATE_TYPE", gateType: g })}
                codeCount={state.codeCount}
                setCodeCount={v => dispatch({ type: "SET_FIELD", field: "codeCount", value: v })}
                allowlistInput={state.allowlistInput}
                setAllowlistInput={v => dispatch({ type: "SET_FIELD", field: "allowlistInput", value: v })}
                tokenAddress={state.tokenAddress}
                setTokenAddress={v => dispatch({ type: "SET_FIELD", field: "tokenAddress", value: v })}
                tokenType={state.tokenType}
                setTokenType={v => dispatch({ type: "SET_FIELD", field: "tokenType", value: v })}
                tokenMinBalance={state.tokenMinBalance}
                setTokenMinBalance={v => dispatch({ type: "SET_FIELD", field: "tokenMinBalance", value: v })}
                tokenSymbol={state.tokenSymbol}
                tokenDecimals={state.tokenDecimals}
                weightedVoting={state.weightedVoting}
                setWeightedVoting={v => dispatch({ type: "SET_FIELD", field: "weightedVoting", value: v })}
                voteThreshold={state.voteThreshold}
                setVoteThreshold={v => dispatch({ type: "SET_FIELD", field: "voteThreshold", value: v })}
                emailDomains={state.emailDomains}
                setEmailDomains={v => dispatch({ type: "SET_FIELD", field: "emailDomains", value: v })}
                githubOrg={state.githubOrg}
                setGithubOrg={v => dispatch({ type: "SET_FIELD", field: "githubOrg", value: v })}
                disabled={creating}
            />

            {/* Gasless toggle */}
            <div
                onClick={() => !toggleDisabled && dispatch({ type: "SET_FIELD", field: "gaslessMode", value: !gaslessMode })}
                role="button"
                style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                    background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)",
                    cursor: toggleDisabled ? "not-allowed" : "pointer", userSelect: "none",
                    opacity: gaslessLocked && !creating ? 0.6 : 1,
                }}
            >
                <div style={{
                    width: 36, height: 20, borderRadius: 10,
                    background: effectiveGasless ? "var(--success)" : "var(--border)",
                    position: "relative", transition: "background 0.2s", flexShrink: 0,
                }}>
                    <div style={{
                        width: 16, height: 16, borderRadius: "50%", background: "white",
                        position: "absolute", top: 2,
                        left: effectiveGasless ? 18 : 2,
                        transition: "left 0.2s",
                    }} />
                </div>
                <div>
                    <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                        {effectiveGasless ? "No wallet needed" : "Wallet required"}
                    </span>
                    <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 2 }}>
                        {walletForced
                            ? "Token gate requires a crypto wallet for on-chain balance verification"
                            : gaslessForced
                                ? "This gate type uses a server-side relayer \u2014 no wallet needed"
                                : effectiveGasless
                                    ? "No wallet needed \u2014 votes are submitted automatically"
                                    : "Voters need a crypto wallet with ETH to submit votes"}
                    </p>
                </div>
            </div>
            {effectiveGasless && (
                <TrustCallout
                    text="Server-side relayer submits transactions on behalf of voters. Trust assumptions: liveness (relayer will submit), timeliness (relayer submits promptly), transport privacy (relayer won't correlate IPs with proofs). Voters independently verify their vote landed on-chain."
                    variant="info"
                />
            )}
        </div>
    )
}
