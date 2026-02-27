//SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

interface ISpectreVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[4] calldata _pubSignals
    ) external view returns (bool);
}

/// @title SpectreVoting — Anonymous encrypted voting with ZK proofs
/// @notice v1: public nullifiers, ECIES-encrypted vote blobs, on-chain dedup
/// @dev Uses Semaphore for group/Merkle tree management, custom Groth16 verifier
///      for SpectreVote circuit (identity + membership + vote commitment + nullifier)
contract SpectreVoting {
    ISemaphore public semaphore;
    ISpectreVerifier public verifier;

    uint256 public groupId;
    uint256 public proposalId;

    // Election public key for ECIES encryption (voter encrypts to this)
    uint256 public electionPubKeyX;
    uint256 public electionPubKeyY;

    // Election state
    bool public votingOpen;
    address public admin;

    // Time-bounded voting: 0 means no deadline (admin-only close)
    uint256 public votingDeadline;

    // v1: public nullifier dedup
    mapping(uint256 => bool) public usedNullifiers;

    // Vote storage
    uint256 public voteCount;

    event ElectionCreated(
        uint256 indexed groupId,
        uint256 indexed proposalId,
        uint256 electionPubKeyX,
        uint256 electionPubKeyY
    );

    event VoterRegistered(
        uint256 indexed groupId,
        uint256 identityCommitment
    );

    event VoteCast(
        uint256 indexed proposalId,
        uint256 indexed nullifierHash,
        uint256 voteCommitment,
        bytes encryptedBlob
    );

    event VotingClosed(uint256 indexed proposalId, uint256 totalVotes);

    error NotAdmin();
    error VotingNotOpen();
    error VotingAlreadyOpen();
    error NullifierAlreadyUsed();
    error InvalidProof();
    error MerkleRootMismatch();
    error InvalidCommitment();
    error VotingDeadlinePassed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenVotingOpen() {
        if (!votingOpen) revert VotingNotOpen();
        if (votingDeadline != 0 && block.timestamp > votingDeadline) revert VotingDeadlinePassed();
        _;
    }

    constructor(
        address _semaphore,
        address _verifier,
        uint256 _proposalId,
        uint256 _electionPubKeyX,
        uint256 _electionPubKeyY,
        address _admin,
        uint256 _votingDeadline
    ) {
        semaphore = ISemaphore(_semaphore);
        verifier = ISpectreVerifier(_verifier);
        admin = _admin == address(0) ? msg.sender : _admin;
        proposalId = _proposalId;
        electionPubKeyX = _electionPubKeyX;
        electionPubKeyY = _electionPubKeyY;
        votingDeadline = _votingDeadline; // 0 = no deadline

        // Create a Semaphore group — this contract becomes the group admin
        groupId = semaphore.createGroup();

        votingOpen = true;

        emit ElectionCreated(groupId, _proposalId, _electionPubKeyX, _electionPubKeyY);
    }

    /// @notice Register a voter's identity commitment into the group
    /// @param identityCommitment Poseidon(BabyJubJub_pubkey) — the voter's identity
    function registerVoter(uint256 identityCommitment) external onlyAdmin {
        if (identityCommitment == 0) revert InvalidCommitment();
        semaphore.addMember(groupId, identityCommitment);
        emit VoterRegistered(groupId, identityCommitment);
    }

    /// @notice Register multiple voters at once
    function registerVoters(uint256[] calldata identityCommitments) external onlyAdmin {
        for (uint256 i = 0; i < identityCommitments.length; i++) {
            if (identityCommitments[i] == 0) revert InvalidCommitment();
        }
        semaphore.addMembers(groupId, identityCommitments);
    }

    /// @notice Cast an anonymous, encrypted vote with a ZK proof
    /// @param pA Groth16 proof point A
    /// @param pB Groth16 proof point B
    /// @param pC Groth16 proof point C
    /// @param merkleTreeRoot The Merkle root the proof was generated against
    /// @param nullifierHash Poseidon(proposalId, secret) — unique per voter per election
    /// @param voteCommitment Poseidon(vote, randomness) — binds encrypted vote to proof
    /// @param encryptedBlob ECIES-encrypted (vote, randomness) to election public key
    function castVote(
        uint[2] calldata pA,
        uint[2][2] calldata pB,
        uint[2] calldata pC,
        uint256 merkleTreeRoot,
        uint256 nullifierHash,
        uint256 voteCommitment,
        bytes calldata encryptedBlob
    ) external whenVotingOpen {
        // 1. Check nullifier hasn't been used (prevents double-voting)
        if (usedNullifiers[nullifierHash]) revert NullifierAlreadyUsed();

        // 2. Verify the Merkle root is valid for our group
        //    For v1, require the current root. Could accept historical roots later.
        if (ISemaphoreGroups(address(semaphore)).getMerkleTreeRoot(groupId) != merkleTreeRoot) {
            revert MerkleRootMismatch();
        }

        // 3. Verify the ZK proof
        //    Public signals: [merkleRoot, nullifierHash, voteCommitment, proposalId]
        uint[4] memory pubSignals = [
            merkleTreeRoot,
            nullifierHash,
            voteCommitment,
            proposalId
        ];

        bool valid = verifier.verifyProof(pA, pB, pC, pubSignals);
        if (!valid) revert InvalidProof();

        // 4. Mark nullifier as used
        usedNullifiers[nullifierHash] = true;
        voteCount++;

        // 5. Emit vote data (encrypted blob stored as event log)
        emit VoteCast(proposalId, nullifierHash, voteCommitment, encryptedBlob);
    }

    /// @notice Close voting — admin can close anytime; anyone can close after deadline
    function closeVoting() external {
        if (!votingOpen) revert VotingNotOpen();
        // Admin can always close. Others can only close after deadline.
        if (msg.sender != admin) {
            if (votingDeadline == 0 || block.timestamp <= votingDeadline) revert NotAdmin();
        }
        votingOpen = false;
        emit VotingClosed(proposalId, voteCount);
    }
}
