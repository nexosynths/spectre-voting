/**
 * Browser-compatible ECIES encryption for Spectre vote payloads.
 *
 * ECIES-secp256k1: ECDH + HKDF-SHA256 + AES-256-GCM
 * Mirrors the SDK's ecies.ts but works entirely in the browser.
 */

import { secp256k1 } from "@noble/curves/secp256k1"
import { gcm } from "@noble/ciphers/aes"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha2"

const DOMAIN_INFO = "spectre-vote-ecies"

/**
 * ECIES-secp256k1 encrypt.
 *
 * Envelope format: [33B ephemeral pubkey] [12B nonce] [N+16B AES-GCM ciphertext+tag]
 *
 * @param electionPubKey — 33-byte compressed secp256k1 public key
 * @param plaintext — bytes to encrypt (vote payload)
 */
export function eciesEncrypt(
    electionPubKey: Uint8Array,
    plaintext: Uint8Array
): Uint8Array {
    // 1. Ephemeral keypair
    const ephPriv = secp256k1.utils.randomPrivateKey()
    const ephPub = secp256k1.getPublicKey(ephPriv) // 33 bytes compressed

    // 2. ECDH → shared x-coordinate
    const sharedPoint = secp256k1.getSharedSecret(ephPriv, electionPubKey)
    const sharedX = sharedPoint.slice(1) // strip prefix → 32 bytes

    // 3. HKDF-SHA256 → 32-byte AES key
    const encKey = hkdf(sha256, sharedX, ephPub, DOMAIN_INFO, 32)

    // 4. AES-256-GCM
    const nonce = randomBytes(12)
    const ciphertext = gcm(encKey, nonce).encrypt(plaintext)

    // 5. Pack envelope
    const envelope = new Uint8Array(33 + 12 + ciphertext.length)
    envelope.set(ephPub, 0)
    envelope.set(nonce, 33)
    envelope.set(ciphertext, 45)
    return envelope
}

/**
 * Encode a vote payload into bytes for ECIES encryption.
 * Format: vote (1 byte) || randomness (32 bytes big-endian)
 * Total: 33 bytes
 *
 * Note: nullifier is NOT included — it's already a public signal in the proof
 * and emitted on-chain in the VoteCast event. Including it in the encrypted
 * blob would be redundant and reduce privacy.
 */
export function encodeVotePayload(vote: bigint, randomness: bigint): Uint8Array {
    const buf = new Uint8Array(33)
    buf[0] = Number(vote)

    // randomness as 32-byte big-endian
    const rHex = randomness.toString(16).padStart(64, "0")
    for (let i = 0; i < 32; i++) {
        buf[1 + i] = parseInt(rHex.substring(i * 2, i * 2 + 2), 16)
    }

    return buf
}

/**
 * ECIES-secp256k1 decrypt.
 *
 * @param electionPrivKey — 32-byte secp256k1 private key
 * @param envelope — output of eciesEncrypt()
 */
export function eciesDecrypt(
    electionPrivKey: Uint8Array,
    envelope: Uint8Array
): Uint8Array {
    // Unpack
    const ephPub = envelope.slice(0, 33)
    const nonce = envelope.slice(33, 45)
    const ciphertext = envelope.slice(45)

    // ECDH → same shared x-coordinate
    const sharedPoint = secp256k1.getSharedSecret(electionPrivKey, ephPub)
    const sharedX = sharedPoint.slice(1)

    // Same KDF
    const encKey = hkdf(sha256, sharedX, ephPub, DOMAIN_INFO, 32)

    // Decrypt (throws if tag mismatch)
    return gcm(encKey, nonce).decrypt(ciphertext)
}

/**
 * Decode a vote payload from bytes.
 * Expects 33 bytes: vote (1 byte) || randomness (32 bytes big-endian)
 */
export function decodeVotePayload(buf: Uint8Array): { vote: bigint; voteRandomness: bigint } {
    const vote = BigInt(buf[0])

    let rHex = ""
    for (let i = 0; i < 32; i++) rHex += buf[1 + i].toString(16).padStart(2, "0")
    const voteRandomness = BigInt("0x" + rHex)

    return { vote, voteRandomness }
}

/**
 * Reconstruct a compressed secp256k1 public key from X and Y coordinates.
 * Returns 33-byte compressed key (0x02/0x03 prefix + 32-byte X).
 */
export function compressPublicKey(x: bigint, y: bigint): Uint8Array {
    const prefix = (y % 2n === 0n) ? 0x02 : 0x03
    const xHex = x.toString(16).padStart(64, "0")
    const compressed = new Uint8Array(33)
    compressed[0] = prefix
    for (let i = 0; i < 32; i++) {
        compressed[1 + i] = parseInt(xHex.substring(i * 2, i * 2 + 2), 16)
    }
    return compressed
}
