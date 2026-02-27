import { secp256k1 } from "@noble/curves/secp256k1"
import { gcm } from "@noble/ciphers/aes"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha2"

const DOMAIN_INFO = "spectre-vote-ecies"

/**
 * ECIES-secp256k1 encrypt.
 *
 * Envelope: [33B ephemeral pubkey] [12B nonce] [N+16B AES-GCM ciphertext+tag]
 *
 * @param electionPubKey — 33-byte compressed secp256k1 public key
 * @param plaintext — bytes to encrypt (vote + randomness encoded)
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
    const sharedX = sharedPoint.slice(1) // strip 0x02/0x03 prefix → 32 bytes

    // 3. HKDF-SHA256 → 32-byte AES key
    const encKey = hkdf(sha256, sharedX, ephPub, DOMAIN_INFO, 32)

    // 4. AES-256-GCM
    const nonce = randomBytes(12)
    const ciphertext = gcm(encKey, nonce).encrypt(plaintext) // ciphertext || 16-byte tag

    // 5. Pack envelope
    const envelope = new Uint8Array(33 + 12 + ciphertext.length)
    envelope.set(ephPub, 0)
    envelope.set(nonce, 33)
    envelope.set(ciphertext, 45)
    return envelope
}

/**
 * ECIES-secp256k1 decrypt.
 *
 * @param electionPrivKey — 32-byte secp256k1 private key (or reconstructed from Shamir shares)
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
 * Generate a new election keypair.
 * In production, the private key would be split via Shamir before being destroyed.
 */
export function generateElectionKeypair() {
    const privateKey = secp256k1.utils.randomPrivateKey()
    const publicKey = secp256k1.getPublicKey(privateKey)
    return { privateKey, publicKey }
}
