pragma circom 2.1.5;

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "@zk-kit/circuits/circom/binary-merkle-root.circom";

// SpectreVote — extends Semaphore V4 with weighted vote commitment + multi-option range check
//
// Proves:
//   1. Identity: secret → BabyJubJub pubkey → Poseidon commitment (Merkle leaf)
//   2. Weighted leaf: Poseidon(identityCommitment, weight) — binds weight to identity
//   3. Membership: weighted leaf is in the group Merkle tree
//   4. Base nullifier: Poseidon(proposalId, secret) — deterministic per voter (tally dedup)
//   5. Versioned nullifier: Poseidon(proposalId, secret, version) — unique per submission (on-chain replay prevention)
//   6. Vote commitment: Poseidon(vote, weight, voteRandomness) — binds encrypted vote + weight to proof
//   7. Vote validity: 0 <= vote < numOptions (supports multi-option elections)
//   8. Weight validity: 1 <= weight < 256
//   9. Version validity: 0 <= version < 6 (max 5 overwrites)
//
// v2: dual nullifiers for coercion resistance (vote overwriting).
//     version is private — observers can't distinguish first votes from overwrites.
template SpectreVote(MAX_DEPTH) {
    // === Private inputs ===
    signal input secret;                                      // EdDSA secret scalar
    signal input weight;                                      // voting weight (1-255)
    signal input merkleProofLength;                           // actual tree depth
    signal input merkleProofIndex;                            // leaf position
    signal input merkleProofSiblings[MAX_DEPTH];              // Merkle proof path
    signal input proposalId;                                  // scope — which election/proposal
    signal input vote;                                        // 0 to numOptions-1
    signal input voteRandomness;                              // blinding factor for vote commitment
    signal input numOptions;                                  // total options (e.g. 2 for yes/no, 4 for multi)
    signal input version;                                     // 0 to 5 (private — observers can't distinguish)

    // === Public outputs ===
    signal output merkleRoot;                                 // group Merkle root
    signal output baseNullifier;                              // Poseidon(proposalId, secret) — tally dedup
    signal output versionedNullifier;                         // Poseidon(proposalId, secret, version) — on-chain uniqueness
    signal output voteCommitment;                             // Poseidon(vote, weight, randomness)

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

    // --- 2. Weight range check: 1 <= weight < 256 ---
    component weightUpperBound = LessThan(8);
    weightUpperBound.in[0] <== weight;
    weightUpperBound.in[1] <== 256;
    weightUpperBound.out === 1;

    component weightNonZero = IsZero();
    weightNonZero.in <== weight;
    weightNonZero.out === 0;   // weight must not be zero

    // --- 3. Weighted leaf: Poseidon(identityCommitment, weight) ---
    var weightedLeaf = Poseidon(2)([identityCommitment, weight]);

    // --- 4. Membership ---
    // Decompose leaf index into bits for BinaryMerkleRoot
    signal merkleProofIndices[MAX_DEPTH];
    component indexBits = Num2Bits(MAX_DEPTH);
    indexBits.in <== merkleProofIndex;
    for (var i = 0; i < MAX_DEPTH; i++) {
        merkleProofIndices[i] <== indexBits.out[i];
    }

    // Verify weighted leaf is in the group Merkle tree
    merkleRoot <== BinaryMerkleRoot(MAX_DEPTH)(
        weightedLeaf,
        merkleProofLength,
        merkleProofIndices,
        merkleProofSiblings
    );

    // --- 5. Nullifiers ---
    // Base nullifier: deterministic per (proposalId, identity). Used for tally dedup.
    baseNullifier <== Poseidon(2)([proposalId, secret]);
    // Versioned nullifier: unique per (proposalId, identity, version). Used on-chain for replay prevention.
    versionedNullifier <== Poseidon(3)([proposalId, secret, version]);

    // --- 6. Vote commitment ---
    // Binds the voter's choice AND weight to the proof. The encrypted blob (sent as calldata)
    // contains (vote, weight, voteRandomness). The committee verifies:
    //   Poseidon(decrypted_vote, decrypted_weight, decrypted_randomness) == on-chain voteCommitment
    voteCommitment <== Poseidon(3)([vote, weight, voteRandomness]);

    // --- 7. Vote validity ---
    // vote must be in range [0, numOptions): 0 <= vote < numOptions
    // LessThan(8) supports up to 2^8 = 256 options
    component voteRange = LessThan(8);
    voteRange.in[0] <== vote;
    voteRange.in[1] <== numOptions;
    voteRange.out === 1;

    // --- 8. Version validity ---
    // version must be in range [0, 6): max 5 overwrites (6 total submissions)
    // LessThan(3) supports 3 bits (0-7), then constrained < 6
    component versionRange = LessThan(3);
    versionRange.in[0] <== version;
    versionRange.in[1] <== 6;
    versionRange.out === 1;
}

// MAX_DEPTH=20 supports groups up to 2^20 = ~1M members
// proposalId and numOptions are public inputs (besides the outputs)
component main {public [proposalId, numOptions]} = SpectreVote(20);
