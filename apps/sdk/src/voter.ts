import { Identity, Group } from "@semaphore-protocol/core"
import { Contract, type Signer } from "ethers"
import { randomBytes } from "@noble/ciphers/webcrypto"
import { generateSpectreProof, type ProofArtifacts, type SpectreProof } from "./prove.js"
import { eciesEncrypt } from "./ecies.js"

// Minimal ABI for SpectreVoting contract interaction
const SPECTRE_VOTING_ABI = [
    "function castVote(uint[2] pA, uint[2][2] pB, uint[2] pC, uint256 merkleTreeRoot, uint256 nullifierHash, uint256 voteCommitment, bytes encryptedBlob) external",
    "function proposalId() view returns (uint256)",
    "function votingOpen() view returns (bool)",
    "function voteCount() view returns (uint256)",
    "function usedNullifiers(uint256) view returns (bool)",
    "event VoteCast(uint256 indexed proposalId, uint256 indexed nullifierHash, uint256 voteCommitment, bytes encryptedBlob)"
]

export interface VotePayload {
    vote: bigint
    voteRandomness: bigint
}

export interface PreparedVote {
    proof: SpectreProof
    encryptedBlob: Uint8Array
    payload: VotePayload
}

/**
 * Encode a vote payload into bytes for ECIES encryption.
 * Format: vote (1 byte) || randomness (32 bytes big-endian)
 * Total: 33 bytes
 *
 * Note: nullifier is NOT included — it's already a public signal in the ZK proof
 * and emitted on-chain in the VoteCast event. Including it in the encrypted
 * blob would be redundant and reduce privacy.
 */
function encodeVotePayload(vote: bigint, randomness: bigint): Uint8Array {
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
 * Decode a vote payload from bytes.
 * Expects 33 bytes: vote (1 byte) || randomness (32 bytes big-endian)
 */
export function decodeVotePayload(buf: Uint8Array): VotePayload {
    const vote = BigInt(buf[0])

    let rHex = ""
    for (let i = 0; i < 32; i++) rHex += buf[1 + i].toString(16).padStart(2, "0")
    const voteRandomness = BigInt("0x" + rHex)

    return { vote, voteRandomness }
}

/**
 * Prepare a vote: generate ZK proof + ECIES-encrypt the vote payload.
 * This is the main voter-side function. Call submitVote() to send it on-chain.
 *
 * @param identity — voter's Semaphore Identity
 * @param group — local mirror of the on-chain Merkle tree
 * @param proposalId — which election
 * @param vote — 0 (NO) or 1 (YES)
 * @param electionPubKey — 33-byte compressed secp256k1 public key
 * @param artifacts — optional custom circuit artifact paths
 */
export async function prepareVote(
    identity: Identity,
    group: Group,
    proposalId: bigint,
    vote: 0n | 1n,
    electionPubKey: Uint8Array,
    artifacts?: Partial<ProofArtifacts>
): Promise<PreparedVote> {
    // Generate random blinding factor
    const randomnessBytes = randomBytes(31) // 31 bytes to stay within field
    let voteRandomness = 0n
    for (const b of randomnessBytes) {
        voteRandomness = (voteRandomness << 8n) | BigInt(b)
    }

    // Generate ZK proof
    const proof = await generateSpectreProof(
        identity,
        group,
        proposalId,
        vote,
        voteRandomness,
        artifacts
    )

    // Encode and encrypt vote payload
    const plaintext = encodeVotePayload(vote, voteRandomness)
    const encryptedBlob = eciesEncrypt(electionPubKey, plaintext)

    return {
        proof,
        encryptedBlob,
        payload: { vote, voteRandomness }
    }
}

/**
 * Submit a prepared vote to the SpectreVoting contract.
 *
 * @param contractAddress — SpectreVoting contract address
 * @param signer — ethers.js Signer (the relayer or voter's wallet)
 * @param prepared — output of prepareVote()
 */
export async function submitVote(
    contractAddress: string,
    signer: Signer,
    prepared: PreparedVote
) {
    const contract = new Contract(contractAddress, SPECTRE_VOTING_ABI, signer)
    const { proof, encryptedBlob } = prepared

    const tx = await contract.castVote(
        proof.pA,
        proof.pB,
        proof.pC,
        proof.merkleRoot,
        proof.nullifierHash,
        proof.voteCommitment,
        encryptedBlob
    )

    return tx.wait()
}
