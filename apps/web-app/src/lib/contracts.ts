// Deployed contract addresses (Sepolia testnet)
export const CONTRACTS = {
    FACTORY: "0xF0Bed4ED7Ab29BA73833e681b2a1E2fbe928df75",
    SEMAPHORE: "0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D",
    GROTH16_VERIFIER: "0xC1d7A22595b2661C4989BA268e4583441Cb31BB4",
    // Legacy single-deploy election (kept for reference)
    SPECTRE_VOTING_LEGACY: "0x20156527E18F3b49f2953Bffa7E62c958317F7c1",
} as const

export const SEPOLIA_CHAIN_ID = 11155111
export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com"

// SpectreVotingFactory ABI
export const FACTORY_ABI = [
    "function semaphore() view returns (address)",
    "function verifier() view returns (address)",
    "function electionCount() view returns (uint256)",
    "function elections(uint256) view returns (address)",
    "function isElection(address) view returns (bool)",
    "function getElections(uint256 offset, uint256 limit) view returns (address[])",
    "function createElection(uint256 _proposalId, uint256 _electionPubKeyX, uint256 _electionPubKeyY, uint256 _votingDeadline) returns (address)",
    "event ElectionDeployed(address indexed election, address indexed admin, uint256 proposalId, uint256 electionPubKeyX, uint256 electionPubKeyY)",
]

// SpectreVoting contract ABI (human-readable, ethers v6)
export const SPECTRE_VOTING_ABI = [
    // View functions
    "function admin() view returns (address)",
    "function groupId() view returns (uint256)",
    "function proposalId() view returns (uint256)",
    "function votingOpen() view returns (bool)",
    "function voteCount() view returns (uint256)",
    "function electionPubKeyX() view returns (uint256)",
    "function electionPubKeyY() view returns (uint256)",
    "function semaphore() view returns (address)",
    "function usedNullifiers(uint256) view returns (bool)",
    "function votingDeadline() view returns (uint256)",
    // Write functions
    "function registerVoter(uint256 identityCommitment)",
    "function registerVoters(uint256[] identityCommitments)",
    "function castVote(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 merkleTreeRoot, uint256 nullifierHash, uint256 voteCommitment, bytes encryptedBlob)",
    "function closeVoting()",
    // Events
    "event VoterRegistered(uint256 indexed groupId, uint256 identityCommitment)",
    "event VoteCast(uint256 indexed proposalId, uint256 indexed nullifierHash, uint256 voteCommitment, bytes encryptedBlob)",
    "event VotingClosed(uint256 indexed proposalId, uint256 totalVotes)",
]

// Semaphore V4 contract ABI (just the events we need for querying group members)
export const SEMAPHORE_ABI = [
    "event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)",
    "event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)",
]
