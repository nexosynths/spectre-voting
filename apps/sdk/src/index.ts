// Spectre SDK — voter-side anonymous encrypted voting
export { eciesEncrypt, eciesDecrypt, generateElectionKeypair } from "./ecies.js"
export { generateSpectreProof, computeVoteCommitment, computeNullifier } from "./prove.js"
export { prepareVote, submitVote, decodeVotePayload } from "./voter.js"

export type { SpectreProof, ProofArtifacts } from "./prove.js"
export type { PreparedVote, VotePayload } from "./voter.js"

// Re-export Semaphore types that consumers need
export { Identity, Group } from "@semaphore-protocol/core"
