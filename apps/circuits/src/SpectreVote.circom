pragma circom 2.1.5;

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "@zk-kit/circuits/circom/binary-merkle-root.circom";

// SpectreVote — extends Semaphore V4 with vote commitment + binary range check
//
// Proves:
//   1. Identity: secret → BabyJubJub pubkey → Poseidon commitment (Merkle leaf)
//   2. Membership: identity commitment is in the group Merkle tree
//   3. Nullifier: Poseidon(proposalId, secret) — deterministic, public in v1
//   4. Vote commitment: Poseidon(vote, voteRandomness) — binds encrypted vote to proof
//   5. Vote validity: vote ∈ {0, 1}
//
// v1: nullifier is public (no coercion resistance). On-chain dedup by nullifier.
// v2: nullifier will be committed (hidden) for coercion resistance.
template SpectreVote(MAX_DEPTH) {
    // === Private inputs ===
    signal input secret;                                      // EdDSA secret scalar
    signal input merkleProofLength;                           // actual tree depth
    signal input merkleProofIndex;                            // leaf position
    signal input merkleProofSiblings[MAX_DEPTH];              // Merkle proof path
    signal input proposalId;                                  // scope — which election/proposal
    signal input vote;                                        // 0 or 1
    signal input voteRandomness;                              // blinding factor for vote commitment

    // === Public outputs ===
    signal output merkleRoot;                                 // group Merkle root
    signal output nullifierHash;                              // identity × proposalId (public in v1)
    signal output voteCommitment;                             // Poseidon(vote, randomness)

    // --- 1. Identity ---
    // Secret scalar must be in the BabyJubJub prime subgroup order
    var l = 2736030358979909402780800718157159386076813972158567259200215660948447373041;
    component isLessThan = LessThan(251);
    isLessThan.in[0] <== secret;
    isLessThan.in[1] <== l;
    isLessThan.out === 1;

    // Derive BabyJubJub public key from secret scalar
    var Ax, Ay;
    (Ax, Ay) = BabyPbk()(secret);

    // Identity commitment = Poseidon(pubkey.x, pubkey.y)
    var identityCommitment = Poseidon(2)([Ax, Ay]);

    // --- 2. Membership ---
    // Decompose leaf index into bits for BinaryMerkleRoot
    signal merkleProofIndices[MAX_DEPTH];
    component indexBits = Num2Bits(MAX_DEPTH);
    indexBits.in <== merkleProofIndex;
    for (var i = 0; i < MAX_DEPTH; i++) {
        merkleProofIndices[i] <== indexBits.out[i];
    }

    // Verify identity commitment is a leaf in the group Merkle tree
    merkleRoot <== BinaryMerkleRoot(MAX_DEPTH)(
        identityCommitment,
        merkleProofLength,
        merkleProofIndices,
        merkleProofSiblings
    );

    // --- 3. Nullifier ---
    // Deterministic per (proposalId, identity). Prevents double-voting in v1.
    nullifierHash <== Poseidon(2)([proposalId, secret]);

    // --- 4. Vote commitment ---
    // Binds the voter's choice to the proof. The encrypted blob (sent as calldata)
    // contains (vote, voteRandomness). The committee verifies:
    //   Poseidon(decrypted_vote, decrypted_randomness) == on-chain voteCommitment
    voteCommitment <== Poseidon(2)([vote, voteRandomness]);

    // --- 5. Vote validity ---
    // vote must be 0 or 1: vote * (vote - 1) === 0
    signal voteCheck;
    voteCheck <== vote * (vote - 1);
    voteCheck === 0;
}

// MAX_DEPTH=20 supports groups up to 2^20 = ~1M members
// proposalId is the only public input (besides the outputs)
component main {public [proposalId]} = SpectreVote(20);
