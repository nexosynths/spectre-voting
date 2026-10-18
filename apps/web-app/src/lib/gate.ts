/**
 * Shared helpers for signup gates (used by both the browser and the relay).
 */

/**
 * Message a token holder signs to prove they control the wallet whose balance
 * qualifies them. Bound to the election, the identity being registered and the
 * wallet, so a signature can't be replayed for another election or identity.
 */
export function tokenGateMessage(electionAddress: string, identityCommitment: string, wallet: string): string {
    return [
        "Spectre: register for an election",
        `Election: ${electionAddress.toLowerCase()}`,
        `Identity: ${identityCommitment}`,
        `Wallet: ${wallet.toLowerCase()}`,
    ].join("\n")
}

/** Gate types whose eligibility is checked by the relay acting as the election's registrar. */
export const RELAY_GATES = ["invite-codes", "allowlist", "email-domain", "github-org", "token-gate"] as const
export type RelayGate = (typeof RELAY_GATES)[number]

export function isRelayGate(gateType: string | undefined | null): gateType is RelayGate {
    return !!gateType && (RELAY_GATES as readonly string[]).includes(gateType)
}
