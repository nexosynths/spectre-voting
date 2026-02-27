/**
 * Threshold encryption for Spectre elections.
 *
 * Shamir secret sharing + dealer ceremony + share reconstruction.
 * Adapted from apps/sdk/src/{shamir,dealer,tally}.ts for browser use.
 *
 * Uses the same @noble/* libraries already in the web app.
 */

import { secp256k1 } from "@noble/curves/secp256k1"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { eciesEncrypt, eciesDecrypt } from "./ecies"

// ─── Shamir Secret Sharing ──────────────────────────────────────────────────

// secp256k1 scalar field order (curve order n)
const ORDER = secp256k1.CURVE.n

/** A single Shamir share: (x, y) where y = f(x) mod ORDER */
export interface Share {
    x: bigint // share index (1..n), never 0
    y: bigint // evaluated polynomial at x
}

function mod(a: bigint, m: bigint): bigint {
    return ((a % m) + m) % m
}

function modInverse(a: bigint, m: bigint): bigint {
    let [old_r, r] = [a, m]
    let [old_s, s] = [1n, 0n]
    while (r !== 0n) {
        const q = old_r / r
        ;[old_r, r] = [r, old_r - q * r]
        ;[old_s, s] = [s, old_s - q * s]
    }
    return mod(old_s, m)
}

function randomScalar(): bigint {
    const bytes = randomBytes(32)
    let val = 0n
    for (const b of bytes) val = (val << 8n) | BigInt(b)
    return mod(val, ORDER)
}

/**
 * Split a secret into n shares with threshold t (t-of-n reconstruction).
 */
function split(secret: bigint, n: number, t: number): Share[] {
    if (t < 2) throw new Error("Threshold must be at least 2")
    if (t > n) throw new Error("Threshold cannot exceed total shares")
    if (secret < 0n || secret >= ORDER) throw new Error("Secret must be in [0, ORDER)")

    const coeffs = [secret]
    for (let i = 1; i < t; i++) coeffs.push(randomScalar())

    const shares: Share[] = []
    for (let i = 1; i <= n; i++) {
        const x = BigInt(i)
        let y = 0n
        let xPow = 1n
        for (const coeff of coeffs) {
            y = mod(y + mod(coeff * xPow, ORDER), ORDER)
            xPow = mod(xPow * x, ORDER)
        }
        shares.push({ x, y })
    }
    return shares
}

/**
 * Reconstruct the secret from t or more shares using Lagrange interpolation at x=0.
 */
function combine(shares: Share[]): bigint {
    if (shares.length < 2) throw new Error("Need at least 2 shares")

    let secret = 0n
    for (let i = 0; i < shares.length; i++) {
        let num = 1n
        let den = 1n
        for (let j = 0; j < shares.length; j++) {
            if (i === j) continue
            num = mod(num * (0n - shares[j].x), ORDER)
            den = mod(den * (shares[i].x - shares[j].x), ORDER)
        }
        const lagrange = mod(num * modInverse(den, ORDER), ORDER)
        secret = mod(secret + mod(shares[i].y * lagrange, ORDER), ORDER)
    }
    return secret
}

// ─── Dealer (Election Setup) ────────────────────────────────────────────────

/** Committee member: identified by their secp256k1 public key. */
export interface CommitteeMember {
    id: string // human-readable identifier
    publicKey: Uint8Array // 33-byte compressed secp256k1 public key
}

/** Encrypted share destined for a specific committee member. */
export interface EncryptedShare {
    memberId: string
    shareIndex: bigint
    encryptedData: Uint8Array // ECIES envelope containing the serialized share
}

/** Result of election setup: dealer distributes encrypted shares. */
export interface ElectionSetup {
    electionPubKey: Uint8Array // 33-byte compressed — published on-chain
    encryptedShares: EncryptedShare[]
    threshold: number
    totalShares: number
}

/** Serialize a share to bytes: x (32B BE) || y (32B BE) = 64 bytes */
export function serializeShare(share: Share): Uint8Array {
    const buf = new Uint8Array(64)
    const xHex = share.x.toString(16).padStart(64, "0")
    const yHex = share.y.toString(16).padStart(64, "0")
    for (let i = 0; i < 32; i++) {
        buf[i] = parseInt(xHex.substring(i * 2, i * 2 + 2), 16)
        buf[32 + i] = parseInt(yHex.substring(i * 2, i * 2 + 2), 16)
    }
    return buf
}

/** Deserialize a share from bytes. */
export function deserializeShare(buf: Uint8Array): Share {
    let xHex = ""
    let yHex = ""
    for (let i = 0; i < 32; i++) {
        xHex += buf[i].toString(16).padStart(2, "0")
        yHex += buf[32 + i].toString(16).padStart(2, "0")
    }
    return { x: BigInt("0x" + xHex), y: BigInt("0x" + yHex) }
}

/**
 * Set up a threshold election: generate keypair, split private key via Shamir,
 * encrypt each share to the corresponding committee member's personal key.
 *
 * The master private key is zeroed after splitting — only the shares survive.
 */
export function setupElection(
    committee: CommitteeMember[],
    threshold: number
): ElectionSetup {
    const n = committee.length
    if (threshold < 2) throw new Error("Threshold must be at least 2")
    if (threshold > n) throw new Error("Threshold cannot exceed committee size")

    // 1. Generate election keypair
    const electionPrivKey = secp256k1.utils.randomPrivateKey()
    const electionPubKey = secp256k1.getPublicKey(electionPrivKey) // 33 bytes compressed

    // Convert private key to bigint for Shamir
    let privKeyBigInt = 0n
    for (const b of electionPrivKey) privKeyBigInt = (privKeyBigInt << 8n) | BigInt(b)

    // 2. Split private key into shares
    const shares = split(privKeyBigInt, n, threshold)

    // 3. Encrypt each share to the corresponding committee member's public key
    const encryptedShares: EncryptedShare[] = committee.map((member, i) => ({
        memberId: member.id,
        shareIndex: shares[i].x,
        encryptedData: eciesEncrypt(member.publicKey, serializeShare(shares[i]))
    }))

    // 4. Zero out the master key
    electionPrivKey.fill(0)

    return {
        electionPubKey,
        encryptedShares,
        threshold,
        totalShares: n
    }
}

// ─── Tally Helpers (Share Decryption + Key Reconstruction) ──────────────────

/**
 * Committee member decrypts their personal share using their private key.
 * This happens on each member's machine — they never expose their private key.
 */
export function decryptShare(memberPrivKey: Uint8Array, encryptedShareData: Uint8Array): Share {
    const serialized = eciesDecrypt(memberPrivKey, encryptedShareData)
    return deserializeShare(serialized)
}

/**
 * Reconstruct the election private key from t decrypted shares.
 * Returns a 32-byte Uint8Array (ready for eciesDecrypt).
 */
export function reconstructElectionKey(shares: Share[]): Uint8Array {
    const secretBigInt = combine(shares)
    const hex = secretBigInt.toString(16).padStart(64, "0")
    const key = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
        key[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
    }
    return key
}

// ─── Hex Serialization Helpers (for copy-paste transport) ───────────────────

/** Convert a decrypted share to a hex string (128 chars = 64 bytes). */
export function shareToHex(share: Share): string {
    const buf = serializeShare(share)
    return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("")
}

/** Parse a hex string back into a Share. */
export function hexToShare(hex: string): Share {
    if (hex.length !== 128) throw new Error("Share hex must be 128 characters (64 bytes)")
    const buf = new Uint8Array(64)
    for (let i = 0; i < 64; i++) {
        buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
    }
    return deserializeShare(buf)
}

/** Convert an encrypted share's data to hex for storage/transport. */
export function encryptedShareToHex(data: Uint8Array): string {
    return Array.from(data).map(b => b.toString(16).padStart(2, "0")).join("")
}

/** Parse hex back into encrypted share data. */
export function hexToEncryptedShare(hex: string): Uint8Array {
    const buf = new Uint8Array(hex.length / 2)
    for (let i = 0; i < buf.length; i++) {
        buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
    }
    return buf
}

/** Generate a fresh secp256k1 keypair (for committee member convenience). */
export function generateCommitteeKeypair(): { privateKeyHex: string; publicKeyHex: string } {
    const privKey = secp256k1.utils.randomPrivateKey()
    const pubKey = secp256k1.getPublicKey(privKey)
    return {
        privateKeyHex: Array.from(privKey).map(b => b.toString(16).padStart(2, "0")).join(""),
        publicKeyHex: Array.from(pubKey).map(b => b.toString(16).padStart(2, "0")).join("")
    }
}

/** Validate a hex string is a valid compressed secp256k1 public key. */
export function isValidPublicKey(hex: string): boolean {
    try {
        if (hex.length !== 66) return false
        const buf = new Uint8Array(33)
        for (let i = 0; i < 33; i++) {
            buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
        }
        // This throws if the point is not on the curve
        secp256k1.ProjectivePoint.fromHex(buf)
        return true
    } catch {
        return false
    }
}
