import { secp256k1 } from "@noble/curves/secp256k1"
import { split, type Share } from "./shamir.js"
import { eciesEncrypt } from "./ecies.js"

/**
 * Committee member: identified by their secp256k1 public key.
 * Shares are encrypted to each member's personal key (not the election key).
 */
export interface CommitteeMember {
    id: string // human-readable identifier
    publicKey: Uint8Array // 33-byte compressed secp256k1 public key
}

/**
 * Encrypted share destined for a specific committee member.
 */
export interface EncryptedShare {
    memberId: string
    shareIndex: bigint
    encryptedData: Uint8Array // ECIES envelope containing the serialized share
}

/**
 * Result of election setup: the dealer distributes encrypted shares
 * and publishes the election public key.
 */
export interface ElectionSetup {
    electionPubKey: Uint8Array // 33-byte compressed — published on-chain
    encryptedShares: EncryptedShare[] // one per committee member, distributed privately
    threshold: number // t — minimum shares to reconstruct
    totalShares: number // n — total committee members
}

/**
 * Serialize a share to bytes: x (32 bytes BE) || y (32 bytes BE)
 */
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

/**
 * Deserialize a share from bytes.
 */
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
 * Set up an election: generate keypair, split private key via Shamir,
 * encrypt each share to the corresponding committee member's personal key.
 *
 * The dealer MUST discard the private key after this function returns.
 * In practice, this runs in a trusted environment (e.g., DAO multisig ceremony).
 *
 * @param committee — list of committee members with their public keys
 * @param threshold — minimum members needed to decrypt (e.g., 5 of 7)
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
    const electionPubKey = secp256k1.getPublicKey(electionPrivKey)

    // Convert private key to bigint for Shamir
    let privKeyBigInt = 0n
    for (const b of electionPrivKey) privKeyBigInt = (privKeyBigInt << 8n) | BigInt(b)

    // 2. Split private key into shares
    const shares = split(privKeyBigInt, n, threshold)

    // 3. Encrypt each share to the corresponding committee member's personal public key
    const encryptedShares: EncryptedShare[] = committee.map((member, i) => ({
        memberId: member.id,
        shareIndex: shares[i].x,
        encryptedData: eciesEncrypt(member.publicKey, serializeShare(shares[i]))
    }))

    // 4. The dealer should zero out electionPrivKey and privKeyBigInt here.
    //    In JS we can't truly guarantee memory zeroing, but we overwrite what we can.
    electionPrivKey.fill(0)

    return {
        electionPubKey,
        encryptedShares,
        threshold,
        totalShares: n
    }
}
