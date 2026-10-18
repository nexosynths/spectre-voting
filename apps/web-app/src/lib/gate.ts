/**
 * Shared helpers for signup gates (used by both the browser and the relay).
 */

import { keccak256, toUtf8Bytes } from "ethers"

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

/**
 * Invite codes are 128 random bits written as 32 lowercase hex characters. Their hashes
 * are public in the election's metadata, so codes must be too long to guess or brute-force.
 */
export const INVITE_CODE_LENGTH = 32
export const INVITE_CODE_PATTERN = /^[0-9a-f]{32}$/

/** Accept codes pasted with spaces, dashes or capitals. */
export function normalizeInviteCode(raw: string): string {
    return raw.toLowerCase().replace(/[\s-]/g, "")
}

/** Show a code in groups of four so people can read it out. */
export function formatInviteCode(code: string): string {
    return code.match(/.{1,4}/g)?.join("-") ?? code
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"])

/**
 * Normalize an email address so that aliases delivering to the same inbox count once:
 * lowercase it, drop a "+tag" from the part before the @, and for Gmail drop dots and
 * treat googlemail.com as gmail.com. Returns null if it isn't a usable address.
 *
 * This doesn't catch every alias: organizations can give one person several addresses
 * (for example first.last@ and flast@), and those still count separately.
 */
export function normalizeEmail(raw: string): string | null {
    const email = String(raw || "").trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
    const at = email.lastIndexOf("@")
    let local = email.slice(0, at)
    let domain = email.slice(at + 1)
    const plus = local.indexOf("+")
    if (plus >= 0) local = local.slice(0, plus)
    if (GMAIL_DOMAINS.has(domain)) {
        domain = "gmail.com"
        local = local.replace(/\./g, "")
    }
    if (!local) return null
    return `${local}@${domain}`
}

/** The domain part of an email address (lowercase), or "" if there isn't one. */
export function emailDomain(raw: string): string {
    const email = String(raw || "").trim().toLowerCase()
    const at = email.lastIndexOf("@")
    return at >= 0 ? email.slice(at + 1) : ""
}

/**
 * Public fingerprint of the relay's gate-key secret. Gated elections record it in their
 * metadata at creation; the relay refuses to register voters if its secret no longer
 * matches, because a different secret would let used credentials register again.
 * 8 bytes of a domain-separated hash: enough to spot a change, not to recover the secret.
 */
export function gateKeyFingerprint(secret: string): string {
    return keccak256(toUtf8Bytes(`spectre-gate-key-fingerprint-v1|${secret}`)).slice(0, 18)
}
