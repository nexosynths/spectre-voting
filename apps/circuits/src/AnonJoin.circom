pragma circom 2.1.5;

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "@zk-kit/circuits/circom/binary-merkle-root.circom";

// AnonJoin — anonymous poll joining via ZK re-keying
//
// Proves:
//   1. Prover knows `secret` for an identity committed in the signup Merkle tree
//   2. joinNullifier = Poseidon(electionId, secret) — prevents double-joining
//   3. A new identity commitment (`newCommitment`) is correctly derived from `newSecret`
//   4. Both secrets are valid BabyJubJub scalars
//
// The key property: the verifier (contract) learns newCommitment and joinNullifier,
// but CANNOT link newCommitment back to any specific leaf in the signup tree.
// This cryptographically breaks the identity-to-vote link.
//
template AnonJoin(MAX_DEPTH) {
    // === Private inputs ===
    signal input secret;                            // existing signup identity secret
    signal input newSecret;                         // new voting identity secret
    signal input merkleProofLength;                 // actual signup tree depth
    signal input merkleProofIndex;                  // leaf position in signup tree
    signal input merkleProofSiblings[MAX_DEPTH];    // Merkle proof path

    // === Public input (via main declaration) ===
    signal input electionId;                        // scopes the join nullifier

    // === Public outputs ===
    signal output signupMerkleRoot;                 // root of signup group tree
    signal output joinNullifier;                    // Poseidon(electionId, secret)
    signal output newCommitment;                    // new voting identity commitment

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

    // --- 2. Derive existing identity commitment from secret ---
    var Ax, Ay;
    (Ax, Ay) = BabyPbk()(secret);
    var identityCommitment = Poseidon(2)([Ax, Ay]);

    // --- 3. Prove membership in signup Merkle tree ---
    signal merkleProofIndices[MAX_DEPTH];
    component indexBits = Num2Bits(MAX_DEPTH);
    indexBits.in <== merkleProofIndex;
    for (var i = 0; i < MAX_DEPTH; i++) {
        merkleProofIndices[i] <== indexBits.out[i];
    }

    signupMerkleRoot <== BinaryMerkleRoot(MAX_DEPTH)(
        identityCommitment,
        merkleProofLength,
        merkleProofIndices,
        merkleProofSiblings
    );

    // --- 4. Join nullifier (prevents double-joining per election) ---
    joinNullifier <== Poseidon(2)([electionId, secret]);

    // --- 5. Derive NEW voting identity commitment from newSecret ---
    var newAx, newAy;
    (newAx, newAy) = BabyPbk()(newSecret);
    newCommitment <== Poseidon(2)([newAx, newAy]);
}

// MAX_DEPTH=20 supports groups up to 2^20 = ~1M members
// electionId is the only public input (besides the outputs)
component main {public [electionId]} = AnonJoin(20);
