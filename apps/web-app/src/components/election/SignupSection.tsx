"use client"

import { useMode } from "@/context/ModeContext"

type Phase = "signup" | "voting" | "closed"

interface SignupSectionProps {
    phase: Phase
    gaslessEnabled: boolean
    address: string | null
    identity: any | null
    connectWallet: () => void
    createIdentity: () => void
    signupStatus: "unknown" | "checking" | "signed-up" | "not-signed-up"
    signupLoading: boolean
    selfSignupAllowed: boolean
    isInviteCodeElection: boolean
    isAllowlistElection: boolean
    inviteCode: string
    setInviteCode: (v: string) => void
    codeValid: boolean
    codeError: string
    allowlistId: string
    setAllowlistId: (v: string) => void
    idValid: boolean
    idError: string
    identityCommitment: string
    handleSignUp: () => void
    copyToClipboard: (text: string, label: string) => void
    copied: string
}

export default function SignupSection({
    phase, gaslessEnabled, address, identity,
    connectWallet, createIdentity,
    signupStatus, signupLoading, selfSignupAllowed,
    isInviteCodeElection, isAllowlistElection,
    inviteCode, setInviteCode, codeValid, codeError,
    allowlistId, setAllowlistId, idValid, idError,
    identityCommitment, handleSignUp, copyToClipboard, copied,
}: SignupSectionProps) {
    const { isSimple } = useMode()

    return (
        <>
            {/* Gasless banner */}
            {gaslessEnabled && (
                <div className="card" style={{ marginBottom: 16, borderColor: "var(--success-border)", background: "var(--success-bg)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: "1.1rem" }}>&#9889;</span>
                        <div>
                            <p style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--success)" }}>
                                {isSimple ? "No wallet needed" : "Gasless Voting"}
                            </p>
                            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                                {isSimple
                                    ? "You can vote directly from this page."
                                    : "No wallet or crypto needed. Your vote is relayed on-chain automatically."}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Step 1: Wallet (required in wallet mode) */}
            {!address && !gaslessEnabled && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>
                        {isSimple ? "Connect Wallet" : "Step 1: Connect Wallet"}
                    </h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
                        Connect to submit transactions on-chain. Your wallet is only for gas — your vote stays anonymous.
                    </p>
                    <button className="btn-primary" onClick={connectWallet} style={{ maxWidth: 200 }}>Connect Wallet</button>
                </div>
            )}

            {/* Step 2: Identity */}
            {address && !gaslessEnabled && !identity && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 4 }}>
                        {isSimple ? "Set Up Your Identity" : "Step 2: Create Identity"}
                    </h4>
                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12 }}>
                        {isSimple
                            ? "Create your anonymous identity. Nobody will be able to see how you voted."
                            : "Generate an anonymous identity for this wallet. Each wallet gets its own identity — nobody can link it to your vote."}
                    </p>
                    <button className="btn-primary" onClick={createIdentity}>Create Identity</button>
                </div>
            )}

            {/* ── SIGNUP PHASE ── */}
            {phase === "signup" && identity && (gaslessEnabled || address) && (
                <div className="card" style={{ marginBottom: 16 }}>
                    {/* Checking status */}
                    {signupStatus === "checking" && (
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <div className="spinner" />
                            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Checking signup status...</p>
                        </div>
                    )}

                    {/* Signed up */}
                    {signupStatus === "signed-up" && (
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ fontSize: "1.2rem", color: "var(--success)" }}>&#10003;</span>
                            <div>
                                <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--success)" }}>You&apos;re signed up!</p>
                                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                                    {isSimple
                                        ? "Waiting for the organizer to open voting."
                                        : "Wait for the admin to close signup. Once voting opens, you\u2019ll anonymously join and cast your vote."}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* ADMIN-ONLY MODE */}
                    {signupStatus !== "checking" && signupStatus !== "signed-up" && !selfSignupAllowed && (
                        <>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>
                                {isSimple ? "Admin Registration Required" : "Admin-Only Registration"}
                            </h4>
                            {isSimple ? (
                                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                    This vote requires the admin to register you. Contact the organizer for access.
                                </p>
                            ) : (
                                <>
                                    <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                        This election uses gated signup — only the admin can register voters. Share your Voter ID with the election admin:
                                    </p>
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <code className="mono" style={{ flex: 1, background: "var(--bg)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.7rem" }}>
                                            {identityCommitment}
                                        </code>
                                        <button onClick={() => copyToClipboard(identityCommitment, "vid")} className="btn-secondary" style={{ width: "auto", padding: "8px 12px", fontSize: "0.7rem" }}>
                                            {copied === "vid" ? "Copied!" : "Copy ID"}
                                        </button>
                                    </div>
                                </>
                            )}
                        </>
                    )}

                    {/* INVITE CODE MODE */}
                    {signupStatus !== "checking" && signupStatus !== "signed-up" && selfSignupAllowed && isInviteCodeElection && (
                        <>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>
                                {isSimple ? "Enter Your Code" : "Enter Invite Code"}
                            </h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                {isSimple
                                    ? "Paste the code you received."
                                    : "This election requires an invite code to sign up. Enter the code you received from the election admin."}
                            </p>
                            <input
                                type="text"
                                placeholder="8-character code"
                                value={inviteCode}
                                onChange={e => setInviteCode(e.target.value.toLowerCase().replace(/[^0-9a-f]/g, ""))}
                                maxLength={8}
                                className="mono"
                                disabled={signupLoading}
                                style={{ textAlign: "center", fontSize: "1.1rem", letterSpacing: "0.15em", marginBottom: 8 }}
                            />
                            {inviteCode.length > 0 && (
                                <p style={{ fontSize: "0.8rem", marginBottom: 8, color: codeValid ? "var(--success)" : codeError ? "var(--error)" : "var(--text-muted)" }}>
                                    {codeValid ? "Code valid" : codeError || "..."}
                                </p>
                            )}
                            <button
                                className="btn-primary"
                                onClick={handleSignUp}
                                disabled={signupLoading || !codeValid}
                            >
                                {signupLoading ? "Signing up..." : "Sign Up with Code"}
                            </button>
                        </>
                    )}

                    {/* ALLOWLIST MODE */}
                    {signupStatus !== "checking" && signupStatus !== "signed-up" && selfSignupAllowed && isAllowlistElection && (
                        <>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>
                                {isSimple ? "Confirm Your Identity" : "Enter Your Identifier"}
                            </h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                {isSimple
                                    ? "Enter the name or email the organizer gave you."
                                    : "This election uses an allowlist. Enter the email, name, or ID the admin registered for you."}
                            </p>
                            <input
                                type="text"
                                placeholder="Your identifier (email, name, ID...)"
                                value={allowlistId}
                                onChange={e => setAllowlistId(e.target.value)}
                                disabled={signupLoading}
                                style={{ marginBottom: 8 }}
                            />
                            {allowlistId.trim().length > 0 && (
                                <p style={{ fontSize: "0.8rem", marginBottom: 8, color: idValid ? "var(--success)" : idError ? "var(--error)" : "var(--text-muted)" }}>
                                    {idValid ? "You\u2019re on the list" : idError || "..."}
                                </p>
                            )}
                            <button
                                className="btn-primary"
                                onClick={handleSignUp}
                                disabled={signupLoading || !idValid}
                            >
                                {signupLoading ? "Signing up..." : "Sign Up"}
                            </button>
                        </>
                    )}

                    {/* OPEN MODE */}
                    {signupStatus !== "checking" && signupStatus !== "signed-up" && selfSignupAllowed && !isInviteCodeElection && !isAllowlistElection && (
                        <>
                            <h4 style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: 6 }}>Sign Up to Vote</h4>
                            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                                {isSimple
                                    ? "Register to participate. Your vote stays secret."
                                    : <>Register for this election. The admin can see who registered, but when you vote, your identity will be cryptographically separated. <strong>Nobody can link your registration to your vote.</strong></>}
                            </p>
                            <button
                                className="btn-primary"
                                onClick={handleSignUp}
                                disabled={signupLoading}
                            >
                                {signupLoading ? "Signing up..." : "Sign Up"}
                            </button>
                        </>
                    )}
                </div>
            )}
        </>
    )
}
