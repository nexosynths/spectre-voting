pragma circom 2.1.5;

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "@zk-kit/circuits/circom/binary-merkle-root.circom";

// AnonJoin — anonymous poll joining via ZK re-keying with weighted voting
//
// Proves:
//   1. Prover knows `secret` for an identity committed in the signup Merkle tree
//   2. joinNullifier = Poseidon(electionId, secret) — prevents double-joining
//   3. A new identity commitment is correctly derived from `newSecret`
//   4. Both secrets are valid BabyJubJub scalars
//   5. Weight is bound to identity via Merkle leaf: Poseidon(identityCommitment, weight)
//   6. Weight is carried through re-key: output = Poseidon(newCommitment, weight)
//
// The key property: the verifier (contract) learns newWeightedCommitment and joinNullifier,
// but CANNOT link them back to any specific leaf in the signup tree.
// Weight is cryptographically bound through the re-key without being revealed.
//
template AnonJoin(MAX_DEPTH) {
    // === Private inputs ===
    signal input secret;                            // existing signup identity secret
    signal input newSecret;                         // new voting identity secret
    signal input weight;                            // voting weight (1-255)
    signal input merkleProofLength;                 // actual signup tree depth
    signal input merkleProofIndex;                  // leaf position in signup tree
    signal input merkleProofSiblings[MAX_DEPTH];    // Merkle proof path

    // === Public input (via main declaration) ===
    signal input electionId;                        // scopes the join nullifier

    // === Public outputs ===
    signal output signupMerkleRoot;                 // root of signup group tree
    signal output joinNullifier;                    // Poseidon(electionId, secret)
    signal output newWeightedCommitment;            // Poseidon(newCommitment, weight)

    // --- 1. Secret range checks (BabyJubJub prime subgroup order) ---
    var l = 2736030358979909402780800718157159386076813972158567259200215660948447373041;

    component secretCheck = LessThan(251);
    secretCheck.in[0] <== secret;
    secretCheck.in[1] <== l;
    secretCheck.out === 1;

    component newSecretCheck = LessThan(251);
    newSecretCheck.in[0] <== newSecret;
    newSecretCheck.in[1] <== l;
    newSecretCheck.out === 1;

    // --- 2. Weight range check: 1 <= weight < 256 ---
    component weightUpperBound = LessThan(8);
    weightUpperBound.in[0] <== weight;
    weightUpperBound.in[1] <== 256;
    weightUpperBound.out === 1;

    component weightNonZero = IsZero();
    weightNonZero.in <== weight;
    weightNonZero.out === 0;   // weight must not be zero

    // --- 3. Derive existing identity commitment from secret ---
    var Ax, Ay;
    (Ax, Ay) = BabyPbk()(secret);
    var identityCommitment = Poseidon(2)([Ax, Ay]);

    // --- 4. Weighted leaf: Poseidon(identityCommitment, weight) ---
    var weightedLeaf = Poseidon(2)([identityCommitment, weight]);

    // --- 5. Prove membership in signup Merkle tree (using weighted leaf) ---
    signal merkleProofIndices[MAX_DEPTH];
    component indexBits = Num2Bits(MAX_DEPTH);
    indexBits.in <== merkleProofIndex;
    for (var i = 0; i < MAX_DEPTH; i++) {
        merkleProofIndices[i] <== indexBits.out[i];
    }

    signupMerkleRoot <== BinaryMerkleRoot(MAX_DEPTH)(
        weightedLeaf,
        merkleProofLength,
        merkleProofIndices,
        merkleProofSiblings
    );

    // --- 6. Join nullifier (prevents double-joining per election) ---
    joinNullifier <== Poseidon(2)([electionId, secret]);

    // --- 7. Derive NEW voting identity commitment from newSecret ---
    var newAx, newAy;
    (newAx, newAy) = BabyPbk()(newSecret);
    var newCommitment = Poseidon(2)([newAx, newAy]);

    // --- 8. Carry weight through re-key: Poseidon(newCommitment, weight) ---
    newWeightedCommitment <== Poseidon(2)([newCommitment, weight]);
}

// MAX_DEPTH=20 supports groups up to 2^20 = ~1M members
// electionId is the only public input (besides the outputs)
component main {public [electionId]} = AnonJoin(20);
