// Deployed contract addresses (Sepolia testnet) — v3: ZK re-key + multi-option
export const CONTRACTS = {
    FACTORY: "0x1910a582e6D4e5ab74e40Cc1474992b1F454caEf",
    SEMAPHORE: "0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D",
    VOTE_VERIFIER: "0xe4a2be410766bCB37Df956334869135fe80AF36d",
    JOIN_VERIFIER: "0xdeE4c3F80332119f59940c363947865bbF7d0585",
} as const

export const SEPOLIA_CHAIN_ID = 11155111
export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com"

// SpectreVotingFactory ABI (v3: two verifiers, signup deadline, numOptions)
export const FACTORY_ABI = [
    "function semaphore() view returns (address)",
    "function voteVerifier() view returns (address)",
    "function joinVerifier() view returns (address)",
    "function electionCount() view returns (uint256)",
    "function elections(uint256) view returns (address)",
    "function isElection(address) view returns (bool)",
    "function getElections(uint256 offset, uint256 limit) view returns (address[])",
    "function createElection(uint256 _proposalId, uint256 _electionPubKeyX, uint256 _electionPubKeyY, uint256 _signupDeadline, uint256 _votingDeadline, uint256 _numOptions, bool _selfSignupAllowed) returns (address)",
    "event ElectionDeployed(address indexed election, address indexed admin, uint256 proposalId, uint256 electionPubKeyX, uint256 electionPubKeyY, uint256 signupDeadline, uint256 votingDeadline, uint256 numOptions, bool selfSignupAllowed)",
]

// SpectreVoting contract ABI (v3: three-phase, ZK re-key, multi-option)
export const SPECTRE_VOTING_ABI = [
    // View functions
    "function admin() view returns (address)",
    "function signupGroupId() view returns (uint256)",
    "function votingGroupId() view returns (uint256)",
    "function proposalId() view returns (uint256)",
    "function numOptions() view returns (uint256)",
    "function signupOpen() view returns (bool)",
    "function votingOpen() view returns (bool)",
    "function voteCount() view returns (uint256)",
    "function electionPubKeyX() view returns (uint256)",
    "function electionPubKeyY() view returns (uint256)",
    "function semaphore() view returns (address)",
    "function usedNullifiers(uint256) view returns (bool)",
    "function usedJoinNullifiers(uint256) view returns (bool)",
    "function signupDeadline() view returns (uint256)",
    "function votingDeadline() view returns (uint256)",
    "function selfSignupAllowed() view returns (bool)",
    // Phase 1: Signup
    "function signUp(uint256 identityCommitment)",
    "function registerVoter(uint256 identityCommitment)",
    "function registerVoters(uint256[] identityCommitments)",
    "function closeSignup()",
    // Phase 2: Anonymous Join + Vote
    "function anonJoin(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 signupRoot, uint256 joinNullifier, uint256 newCommitment)",
    "function castVote(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 merkleTreeRoot, uint256 nullifierHash, uint256 voteCommitment, bytes encryptedBlob)",
    "function closeVoting()",
    // Events
    "event VoterSignedUp(uint256 indexed signupGroupId, uint256 identityCommitment)",
    "event AnonJoined(uint256 indexed votingGroupId, uint256 joinNullifier, uint256 newCommitment)",
    "event VoteCast(uint256 indexed proposalId, uint256 indexed nullifierHash, uint256 voteCommitment, bytes encryptedBlob)",
    "event SignupClosed(uint256 indexed proposalId)",
    "event VotingClosed(uint256 indexed proposalId, uint256 totalVotes)",
    // Custom errors
    "error NotAdmin()",
    "error SignupNotOpen()",
    "error VotingNotOpen()",
    "error VotingAlreadyOpen()",
    "error SignupAlreadyClosed()",
    "error NullifierAlreadyUsed()",
    "error JoinNullifierAlreadyUsed()",
    "error InvalidProof()",
    "error MerkleRootMismatch()",
    "error InvalidCommitment()",
    "error VotingDeadlinePassed()",
    "error SignupDeadlinePassed()",
    "error SignupStillOpen()",
    "error InvalidNumOptions()",
    "error SelfSignupNotAllowed()",
]

// Semaphore V4 contract ABI (events for querying group members)
export const SEMAPHORE_ABI = [
    "event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)",
    "event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)",
]
