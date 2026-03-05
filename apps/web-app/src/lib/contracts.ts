// Deployed contract addresses (Base mainnet) — v2: weighted voting circuits
export const CONTRACTS = {
    FACTORY: "0x1581c010cC06942ADEEc85baa9a3D19a7e82A21e",
    SEMAPHORE: "0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D",
    VOTE_VERIFIER: "0xD0B778a60E57be0681f660E9c9319274EB10272E",
    JOIN_VERIFIER: "0x753126E842baa748e46384c115e1CF6952c01522",
} as const

export const CHAIN_ID = 8453
export const RPC_URL = "https://base.publicnode.com"
export const EXPLORER_URL = "https://basescan.org"

// Base RPC limits eth_getLogs to 10,000 blocks per call
export const MAX_LOG_RANGE = 9500
// Factory deployment block on Base mainnet (used as lower bound for event scans)
export const FACTORY_DEPLOY_BLOCK = 42893400

// SpectreVotingFactory ABI (v3: two verifiers, signup deadline, numOptions)
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
    "function createElection(uint256 _proposalId, uint256 _electionPubKeyX, uint256 _electionPubKeyY, uint256 _signupDeadline, uint256 _votingDeadline, uint256 _numOptions, bool _selfSignupAllowed, bytes _metadata) returns (address)",
    "event ElectionDeployed(address indexed election, address indexed admin, uint256 proposalId, uint256 electionPubKeyX, uint256 electionPubKeyY, uint256 signupDeadline, uint256 votingDeadline, uint256 numOptions, bool selfSignupAllowed, bytes metadata)",
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
    "function uniqueVoterCount() view returns (uint256)",
    "function knownVoters(uint256) view returns (bool)",
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
    "event VoterSignedUp(uint256 indexed signupGroupId, uint256 identityCommitment)",
    "event AnonJoined(uint256 indexed votingGroupId, uint256 joinNullifier, uint256 newCommitment)",
    "event VoteCast(uint256 indexed proposalId, uint256 indexed baseNullifier, uint256 versionedNullifier, uint256 voteCommitment, bytes encryptedBlob)",
    "event SignupClosed(uint256 indexed proposalId)",
    "event VotingClosed(uint256 indexed proposalId, uint256 totalVotes)",
    "event TallyCommitted(uint256 indexed proposalId, uint256 poseidonCommitment, uint256 totalValid, uint256 totalInvalid, uint256[] optionCounts)",
    // Threshold committee
    "function committeeThreshold() view returns (uint256)",
    "function isCommitteeMember(address) view returns (bool)",
    "function committeePublicKeys(address) view returns (bytes)",
    "function registeredKeyCount() view returns (uint256)",
    "function committeeFinalized() view returns (bool)",
    "function decryptedShares(address) view returns (bytes)",
    "function hasSubmittedShare(address) view returns (bool)",
    "function submittedShareCount() view returns (uint256)",
    "function setupCommittee(uint256 _threshold, address[] _members)",
    "function registerCommitteeKey(bytes _publicKey)",
    "function finalizeCommittee(uint256 _pubKeyX, uint256 _pubKeyY, bytes _encryptedSharesData)",
    "function submitDecryptedShare(bytes _share)",
    "function getCommitteeMembers() view returns (address[])",
    "function getDecryptedShare(address _member) view returns (bytes)",
    // Committee events
    "event CommitteeSetup(uint256 indexed proposalId, uint256 threshold, address[] members)",
    "event CommitteeKeyRegistered(uint256 indexed proposalId, address indexed member, bytes publicKey)",
    "event CommitteeFinalized(uint256 indexed proposalId, uint256 pubKeyX, uint256 pubKeyY, bytes encryptedSharesData)",
    "event DecryptedShareSubmitted(uint256 indexed proposalId, address indexed member, bytes share)",
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
    "error TallyAlreadyCommitted()",
    "error VotingStillOpen()",
    "error InvalidOptionCount()",
    // Committee errors
    "error CommitteeAlreadySetup()",
    "error CommitteeNotSetup()",
    "error NotCommitteeMember()",
    "error KeyAlreadyRegistered()",
    "error CommitteeAlreadyFinalized()",
    "error NotAllKeysRegistered()",
    "error InvalidThreshold()",
    "error ShareAlreadySubmitted()",
    "error InvalidPublicKey()",
    "error ElectionKeyNotSet()",
    "error CommitteeNotFinalized()",
]

// Semaphore V4 contract ABI (events for querying group members)
export const SEMAPHORE_ABI = [
    "event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)",
    "event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)",
]
