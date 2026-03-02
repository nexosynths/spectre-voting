"use client"

import { useEffect } from "react"
import GateSelector from "./GateSelector"
import ContextualWarnings from "./ContextualWarning"
import TrustSummary from "./TrustSummary"

type GateType = "open" | "invite-codes" | "allowlist" | "admin-only" | "token-gate" | "email-domain"

interface CreateSimpleFormProps {
    electionTitle: string
    setElectionTitle: (v: string) => void
    optionLabels: string[]
    addOption: () => void
    removeOption: (i: number) => void
    updateOption: (i: number, v: string) => void
    gateType: GateType
    setGateType: (g: GateType) => void
    codeCount: string
    setCodeCount: (v: string) => void
    allowlistInput: string
    setAllowlistInput: (v: string) => void
    tokenAddress: string
    setTokenAddress: (v: string) => void
    tokenType: "erc20" | "erc721"
    setTokenType: (v: "erc20" | "erc721") => void
    tokenMinBalance: string
    setTokenMinBalance: (v: string) => void
    tokenSymbol: string
    tokenDecimals: number
    emailDomains: string
    setEmailDomains: (v: string) => void
    creating: boolean
    onSubmit: () => void
    // Hidden field setters — Simple mode forces defaults
    setSignupHours: (v: string) => void
    setVotingHours: (v: string) => void
    setGaslessMode: (v: boolean) => void
    setEncryptionMode: (v: "single" | "threshold") => void
}

export default function CreateSimpleForm({
    electionTitle, setElectionTitle,
    optionLabels, addOption, removeOption, updateOption,
    gateType, setGateType, codeCount, setCodeCount,
    allowlistInput, setAllowlistInput,
    tokenAddress, setTokenAddress, tokenType, setTokenType,
    tokenMinBalance, setTokenMinBalance, tokenSymbol, tokenDecimals,
    emailDomains, setEmailDomains,
    creating, onSubmit,
    setSignupHours, setVotingHours, setGaslessMode, setEncryptionMode,
}: CreateSimpleFormProps) {
    // Force Simple mode defaults on mount
    useEffect(() => {
        setSignupHours("24")
        setVotingHours("72")
        setGaslessMode(true)
        setEncryptionMode("single")
        // Reset gate type if it's admin-only (not available in Simple mode)
        if (gateType === "admin-only") setGateType("open")
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
            <h4 style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: 4 }}>Create a Vote</h4>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                Votes are anonymous and encrypted. No one — not even you — can see who voted for what.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                {/* Title */}
                <input
                    type="text"
                    placeholder="What are you voting on?"
                    value={electionTitle}
                    onChange={e => setElectionTitle(e.target.value)}
                    disabled={creating}
                />

                {/* Vote options */}
                <div>
                    <label style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>
                        Options ({optionLabels.length})
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {optionLabels.map((label, i) => (
                            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <input
                                    type="text"
                                    placeholder={`Option ${i + 1}`}
                                    value={label}
                                    onChange={e => updateOption(i, e.target.value)}
                                    disabled={creating}
                                    style={{ flex: 1 }}
                                />
                                {optionLabels.length > 2 && (
                                    <button
                                        onClick={() => removeOption(i)}
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
                            onClick={addOption}
                            disabled={creating}
                            style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.8rem", cursor: "pointer", padding: "6px 0", marginTop: 4 }}
                        >
                            + Add option
                        </button>
                    )}
                </div>

                {/* Gate selector (Simple mode — 3 options) */}
                <GateSelector
                    gateType={gateType}
                    setGateType={setGateType}
                    codeCount={codeCount}
                    setCodeCount={setCodeCount}
                    allowlistInput={allowlistInput}
                    setAllowlistInput={setAllowlistInput}
                    tokenAddress={tokenAddress}
                    setTokenAddress={setTokenAddress}
                    tokenType={tokenType}
                    setTokenType={setTokenType}
                    tokenMinBalance={tokenMinBalance}
                    setTokenMinBalance={setTokenMinBalance}
                    tokenSymbol={tokenSymbol}
                    tokenDecimals={tokenDecimals}
                    emailDomains={emailDomains}
                    setEmailDomains={setEmailDomains}
                    disabled={creating}
                />

                {/* Contextual warnings */}
                <ContextualWarnings config={{
                    gateType,
                    gaslessMode: true,
                    encryptionMode: "single",
                    signupHours: 24,
                    votingHours: 72,
                    numOptions: optionLabels.length,
                }} />
            </div>

            {/* Trust summary strip */}
            <TrustSummary
                gateType={gateType}
                gaslessMode={true}
                encryptionMode="single"
            />

            {/* Create */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", flex: 1 }}>
                    Registration: 24h · Voting: 72h
                </p>
                <button
                    className="btn-primary"
                    onClick={onSubmit}
                    disabled={creating || !electionTitle.trim()}
                    style={{ width: "auto", padding: "12px 20px" }}
                >
                    {creating ? "Creating..." : "Create Vote"}
                </button>
            </div>
        </div>
    )
}
