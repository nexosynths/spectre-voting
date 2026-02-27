// Spectre SDK — anonymous encrypted voting with threshold decryption

// Voter-side
export { eciesEncrypt, eciesDecrypt, generateElectionKeypair } from "./ecies.js"
export { generateSpectreProof, computeVoteCommitment, computeNullifier } from "./prove.js"
export { prepareVote, submitVote, decodeVotePayload } from "./voter.js"

// Threshold key management (dealer + committee)
export { split, combine } from "./shamir.js"
export { setupElection, serializeShare, deserializeShare } from "./dealer.js"
export { decryptShare, reconstructElectionKey, computeTally, computeTallyCommitment, verifyTallyCommitment } from "./tally.js"

// Types
export type { SpectreProof, ProofArtifacts } from "./prove.js"
export type { PreparedVote, VotePayload } from "./voter.js"
export type { Share } from "./shamir.js"
export type { CommitteeMember, EncryptedShare, ElectionSetup } from "./dealer.js"
export type { SubmittedVote, DecryptedVote, TallyResult } from "./tally.js"

// Re-export Semaphore types that consumers need
export { Identity, Group } from "@semaphore-protocol/core"
