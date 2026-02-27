//SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

interface ISpectreVoteVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[5] calldata _pubSignals
    ) external view returns (bool);
}

interface IAnonJoinVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[4] calldata _pubSignals
    ) external view returns (bool);
}

/// @title SpectreVoting — Anonymous encrypted voting with ZK re-keyed registration
/// @notice Three-phase election:
///   Phase 1 (Signup):  Voters publicly register identity commitments
///   Phase 2 (Join+Vote): Voters anonymously re-key into voting group via ZK proof, then cast votes
///   Phase 3 (Closed):  Tally
///
/// @dev Two Semaphore groups per election:
///   - signupGroupId: populated during Phase 1 (public signup)
///   - votingGroupId: populated during Phase 2 (anonymous join via AnonJoin ZK proof)
///
///   The AnonJoin proof cryptographically breaks the link between signup identity and
///   voting identity, preventing timing correlation attacks by the admin.
contract SpectreVoting {
    ISemaphore public semaphore;
    ISpectreVoteVerifier public voteVerifier;
    IAnonJoinVerifier public joinVerifier;

    uint256 public signupGroupId;
    uint256 public votingGroupId;
    uint256 public proposalId;

    // Multi-option voting: numOptions choices (e.g. 2 for yes/no, 4 for multi)
    uint256 public numOptions;

    // Election public key for ECIES encryption (voter encrypts to this)
    uint256 public electionPubKeyX;
    uint256 public electionPubKeyY;

    // Election state & phase management
    //   Phase 1: signupOpen = true,  votingOpen = false
    //   Phase 2: signupOpen = false, votingOpen = true
    //   Phase 3: signupOpen = false, votingOpen = false
    bool public signupOpen;
    bool public votingOpen;
    address public admin;

    // Phase deadlines
    uint256 public signupDeadline;  // 0 = no deadline (admin-only close)
    uint256 public votingDeadline;  // 0 = no deadline (admin-only close)

    // v1: public nullifier dedup for votes
    mapping(uint256 => bool) public usedNullifiers;

    // AnonJoin nullifier dedup (prevents double-joining)
    mapping(uint256 => bool) public usedJoinNullifiers;

    // Vote storage
    uint256 public voteCount;

    event ElectionCreated(
        uint256 indexed signupGroupId,
        uint256 indexed votingGroupId,
        uint256 indexed proposalId,
        uint256 electionPubKeyX,
        uint256 electionPubKeyY,
        uint256 numOptions
    );

    event VoterSignedUp(
        uint256 indexed signupGroupId,
        uint256 identityCommitment
    );

    event AnonJoined(
        uint256 indexed votingGroupId,
        uint256 joinNullifier,
        uint256 newCommitment
    );

    event VoteCast(
        uint256 indexed proposalId,
        uint256 indexed nullifierHash,
        uint256 voteCommitment,
        bytes encryptedBlob
    );

    event SignupClosed(uint256 indexed proposalId);
    event VotingClosed(uint256 indexed proposalId, uint256 totalVotes);

    error NotAdmin();
    error SignupNotOpen();
    error VotingNotOpen();
    error VotingAlreadyOpen();
    error SignupAlreadyClosed();
    error NullifierAlreadyUsed();
    error JoinNullifierAlreadyUsed();
    error InvalidProof();
    error MerkleRootMismatch();
    error InvalidCommitment();
    error VotingDeadlinePassed();
    error SignupDeadlinePassed();
    error SignupStillOpen();
    error InvalidNumOptions();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenSignupOpen() {
        if (!signupOpen) revert SignupNotOpen();
        if (signupDeadline != 0 && block.timestamp > signupDeadline) revert SignupDeadlinePassed();
        _;
    }

    modifier whenVotingOpen() {
        if (!votingOpen) revert VotingNotOpen();
        if (votingDeadline != 0 && block.timestamp > votingDeadline) revert VotingDeadlinePassed();
        _;
    }

    constructor(
        address _semaphore,
        address _voteVerifier,
        address _joinVerifier,
        uint256 _proposalId,
        uint256 _electionPubKeyX,
        uint256 _electionPubKeyY,
        address _admin,
        uint256 _signupDeadline,
        uint256 _votingDeadline,
        uint256 _numOptions
    ) {
        if (_numOptions < 2) revert InvalidNumOptions();

        semaphore = ISemaphore(_semaphore);
        voteVerifier = ISpectreVoteVerifier(_voteVerifier);
        joinVerifier = IAnonJoinVerifier(_joinVerifier);
        admin = _admin == address(0) ? msg.sender : _admin;
        proposalId = _proposalId;
        electionPubKeyX = _electionPubKeyX;
        electionPubKeyY = _electionPubKeyY;
        signupDeadline = _signupDeadline;
        votingDeadline = _votingDeadline;
        numOptions = _numOptions;

        // Create two Semaphore groups — this contract becomes the group admin for both
        signupGroupId = semaphore.createGroup();
        votingGroupId = semaphore.createGroup();

        // Start in Phase 1: signup open, voting closed
        signupOpen = true;
        votingOpen = false;

        emit ElectionCreated(signupGroupId, votingGroupId, _proposalId, _electionPubKeyX, _electionPubKeyY, _numOptions);
    }

    // =======================================================================
    // Phase 1: Signup — public registration
    // =======================================================================

    /// @notice Self-register during signup phase. Anyone can call.
    /// @param identityCommitment Poseidon(BabyJubJub_pubkey) — the voter's signup identity
    function signUp(uint256 identityCommitment) external whenSignupOpen {
        if (identityCommitment == 0) revert InvalidCommitment();
        semaphore.addMember(signupGroupId, identityCommitment);
        emit VoterSignedUp(signupGroupId, identityCommitment);
    }

    /// @notice Admin registers a voter's identity commitment into the signup group
    /// @param identityCommitment Poseidon(BabyJubJub_pubkey) — the voter's signup identity
    function registerVoter(uint256 identityCommitment) external onlyAdmin whenSignupOpen {
        if (identityCommitment == 0) revert InvalidCommitment();
        semaphore.addMember(signupGroupId, identityCommitment);
        emit VoterSignedUp(signupGroupId, identityCommitment);
    }

    /// @notice Admin registers multiple voters at once
    function registerVoters(uint256[] calldata identityCommitments) external onlyAdmin whenSignupOpen {
        for (uint256 i = 0; i < identityCommitments.length; i++) {
            if (identityCommitments[i] == 0) revert InvalidCommitment();
        }
        semaphore.addMembers(signupGroupId, identityCommitments);
    }

    /// @notice Close signup and open voting. Admin can close anytime; anyone after deadline.
    function closeSignup() external {
        if (!signupOpen) revert SignupAlreadyClosed();
        // Admin can always close. Others can only close after deadline.
        if (msg.sender != admin) {
            if (signupDeadline == 0 || block.timestamp <= signupDeadline) revert NotAdmin();
        }
        signupOpen = false;
        votingOpen = true;
        emit SignupClosed(proposalId);
    }

    // =======================================================================
    // Phase 2: Anonymous Join + Vote
    // =======================================================================

    /// @notice Anonymously join the voting group with a ZK re-key proof.
    ///         Proves membership in signup group without revealing which member,
    ///         and outputs a new delinked voting commitment.
    /// @param pA Groth16 proof point A
    /// @param pB Groth16 proof point B
    /// @param pC Groth16 proof point C
    /// @param signupRoot The signup Merkle root the proof was generated against
    /// @param joinNullifier Poseidon(electionId, secret) — prevents double-joining
    /// @param newCommitment New voting identity commitment (delinked from signup)
    function anonJoin(
        uint[2] calldata pA,
        uint[2][2] calldata pB,
        uint[2] calldata pC,
        uint256 signupRoot,
        uint256 joinNullifier,
        uint256 newCommitment
    ) external whenVotingOpen {
        // 1. Check join nullifier hasn't been used (prevents double-joining)
        if (usedJoinNullifiers[joinNullifier]) revert JoinNullifierAlreadyUsed();

        // 2. Verify the signup Merkle root is valid for the signup group
        if (ISemaphoreGroups(address(semaphore)).getMerkleTreeRoot(signupGroupId) != signupRoot) {
            revert MerkleRootMismatch();
        }

        // 3. Verify the AnonJoin ZK proof
        //    Public signals: [signupMerkleRoot, joinNullifier, newCommitment, electionId]
        //    electionId is proposalId for this election
        uint[4] memory pubSignals = [
            signupRoot,
            joinNullifier,
            newCommitment,
            proposalId
        ];

        bool valid = joinVerifier.verifyProof(pA, pB, pC, pubSignals);
        if (!valid) revert InvalidProof();

        // 4. Mark join nullifier as used
        usedJoinNullifiers[joinNullifier] = true;

        // 5. Add new commitment to the voting group
        if (newCommitment == 0) revert InvalidCommitment();
        semaphore.addMember(votingGroupId, newCommitment);

        emit AnonJoined(votingGroupId, joinNullifier, newCommitment);
    }

    /// @notice Cast an anonymous, encrypted vote with a ZK proof
    /// @param pA Groth16 proof point A
    /// @param pB Groth16 proof point B
    /// @param pC Groth16 proof point C
    /// @param merkleTreeRoot The voting group Merkle root the proof was generated against
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

        // 2. Verify the Merkle root is valid for the voting group
        if (ISemaphoreGroups(address(semaphore)).getMerkleTreeRoot(votingGroupId) != merkleTreeRoot) {
            revert MerkleRootMismatch();
        }

        // 3. Verify the ZK proof
        //    Public signals: [merkleRoot, nullifierHash, voteCommitment, proposalId, numOptions]
        uint[5] memory pubSignals = [
            merkleTreeRoot,
            nullifierHash,
            voteCommitment,
            proposalId,
            numOptions
        ];

        bool valid = voteVerifier.verifyProof(pA, pB, pC, pubSignals);
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
