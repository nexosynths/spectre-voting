// Contract addresses (Base mainnet), v9: time-locked ballots, registrar-enforced gates.
//
// The v9 contracts aren't deployed yet. Until FACTORY is filled in, the app shows a
// "not configured" notice instead of talking to older, incompatible contracts.
// After deploying (see apps/contracts/scripts/deploy-factory.ts), set FACTORY and
// FACTORY_DEPLOY_BLOCK below.
export const CONTRACTS = {
    FACTORY: "",
    SEMAPHORE: "0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D",
} as const

export const FACTORY_CONFIGURED = /^0x[0-9a-fA-F]{40}$/.test(CONTRACTS.FACTORY)

export const CHAIN_ID = 8453
export const RPC_URL = "https://base.publicnode.com"
export const EXPLORER_URL = "https://basescan.org"

// Base RPC limits eth_getLogs to 10,000 blocks per call
export const MAX_LOG_RANGE = 9500
// Factory deployment block on Base mainnet (lower bound for scans of the factory's events). Update with FACTORY.
export const FACTORY_DEPLOY_BLOCK = 0

// The contract version this frontend understands (SpectreVoting.VERSION).
export const SUPPORTED_ELECTION_VERSION = 9n

/** SpectreVoting.Config, as passed to createElection */
export interface ElectionConfig {
    proposalId: bigint
    signupDeadline: bigint
    votingDeadline: bigint
    numOptions: bigint
    maxVoters: bigint
    maxWeight: bigint
    selfSignupAllowed: boolean
    registrar: string
}

// SpectreVotingFactory ABI (v9)
export const FACTORY_ABI = [
    "function semaphore() view returns (address)",
    "function voteVerifier() view returns (address)",
    "function joinVerifier() view returns (address)",
    "function creationFee() view returns (uint256)",
    "function owner() view returns (address)",
    "function electionCount() view returns (uint256)",
    "function elections(uint256) view returns (address)",
    "function isElection(address) view returns (bool)",
    "function getElections(uint256 offset, uint256 limit) view returns (address[])",
    "function createElection(tuple(uint256 proposalId, uint256 signupDeadline, uint256 votingDeadline, uint256 numOptions, uint256 maxVoters, uint256 maxWeight, bool selfSignupAllowed, address registrar) _config, bytes _metadata) payable returns (address)",
    "event ElectionDeployed(address indexed election, address indexed admin, uint256 proposalId, uint256 signupDeadline, uint256 votingDeadline, uint256 numOptions, bool selfSignupAllowed, address registrar, bytes metadata)",
]

// SpectreVoting ABI (v9)
export const SPECTRE_VOTING_ABI = [
    // View functions
    "function VERSION() view returns (uint256)",
    "function MAX_WEIGHT() view returns (uint256)",
    "function MAX_VOTERS_LIMIT() view returns (uint256)",
    "function MAX_BALLOT_BYTES() view returns (uint256)",
    "function maxVoters() view returns (uint256)",
    "function maxWeight() view returns (uint256)",
    "function registrationCount() view returns (uint256)",
    "function deployBlock() view returns (uint256)",
    "function admin() view returns (address)",
    "function registrar() view returns (address)",
    "function signupGroupId() view returns (uint256)",
    "function votingGroupId() view returns (uint256)",
    "function proposalId() view returns (uint256)",
    "function numOptions() view returns (uint256)",
    "function signupOpen() view returns (bool)",
    "function votingOpen() view returns (bool)",
    "function voteCount() view returns (uint256)",
    "function uniqueVoterCount() view returns (uint256)",
    "function knownVoters(uint256) view returns (bool)",
    "function semaphore() view returns (address)",
    "function usedNullifiers(uint256) view returns (bool)",
    "function usedJoinNullifiers(uint256) view returns (bool)",
    "function usedGateKeys(bytes32) view returns (bool)",
    "function signupDeadline() view returns (uint256)",
    "function votingDeadline() view returns (uint256)",
    "function selfSignupAllowed() view returns (bool)",
    // Phase 1: Signup
    "function signUp(uint256 identityCommitment)",
    "function registerVoter(uint256 identityCommitment, uint256 weight, bytes32 gateKey)",
    "function registerVoters(uint256[] identityCommitments)",
    "function setRegistrar(address newRegistrar)",
    "function closeSignup()",
    // Phase 2: Anonymous Join + Vote
    "function anonJoin(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 signupRoot, uint256 joinNullifier, uint256 newCommitment)",
    "function castVote(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 merkleTreeRoot, uint256 baseNullifier, uint256 versionedNullifier, uint256 voteCommitment, bytes encryptedBlob)",
    "function closeVoting()",
    // Phase 3: Tally commitment
    "function commitTallyResult(uint256[] optionCounts, uint256 totalValid, uint256 totalInvalid, uint256 poseidonCommitment)",
    "function tallyCommitted() view returns (bool)",
    "function tallyPoseidonCommitment() view returns (uint256)",
    "function tallyTotalValid() view returns (uint256)",
    "function tallyTotalInvalid() view returns (uint256)",
    "function getTallyOptionCounts() view returns (uint256[])",
    // Events
    "event ElectionCreated(uint256 indexed signupGroupId, uint256 indexed votingGroupId, uint256 indexed proposalId, uint256 numOptions)",
    "event VoterSignedUp(uint256 indexed signupGroupId, uint256 identityCommitment, uint256 weight)",
    "event RegistrarChanged(address indexed previousRegistrar, address indexed newRegistrar)",
    "event AnonJoined(uint256 indexed votingGroupId, uint256 joinNullifier, uint256 newCommitment)",
    "event VoteCast(uint256 indexed proposalId, uint256 indexed baseNullifier, uint256 versionedNullifier, uint256 voteCommitment, bytes encryptedBlob)",
    "event SignupClosed(uint256 indexed proposalId)",
    "event VotingClosed(uint256 indexed proposalId, uint256 totalVotes)",
    "event TallyCommitted(uint256 indexed proposalId, uint256 poseidonCommitment, uint256 totalValid, uint256 totalInvalid, uint256[] optionCounts)",
    // Custom errors
    "error NotAdmin()",
    "error NotAuthorized()",
    "error SignupNotOpen()",
    "error VotingNotOpen()",
    "error VotingAlreadyOpen()",
    "error SignupAlreadyClosed()",
    "error NullifierAlreadyUsed()",
    "error JoinNullifierAlreadyUsed()",
    "error InvalidProof()",
    "error MerkleRootMismatch()",
    "error InvalidCommitment()",
    "error InvalidWeight()",
    "error GateKeyAlreadyUsed()",
    "error InvalidGateKey()",
    "error InvalidDeadlines()",
    "error VotingDeadlinePassed()",
    "error VotingNotEnded()",
    "error SignupDeadlinePassed()",
    "error SignupStillOpen()",
    "error InvalidNumOptions()",
    "error SelfSignupNotAllowed()",
    "error TallyAlreadyCommitted()",
    "error VotingStillOpen()",
    "error InvalidOptionCount()",
    "error InvalidMaxVoters()",
    "error TooManyVoters()",
    "error BallotTooLarge()",
]

// Semaphore V4 contract ABI (events for querying group members)
export const SEMAPHORE_ABI = [
    "event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)",
    "event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)",
]
