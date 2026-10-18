//SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";
import "poseidon-solidity/PoseidonT3.sol";

interface ISpectreVoteVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[6] calldata _pubSignals
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

/// @title SpectreVoting (v9): anonymous voting with ZK re-keyed registration
/// @notice Three-phase election:
///   Phase 1 (Signup):    voters' identity commitments are registered publicly, until the
///                        signup deadline (the admin can end signup earlier)
///   Phase 2 (Join+Vote): voters re-key into the voting group with a ZK proof, then cast ballots,
///                        until the voting deadline. Voting opens automatically after signup ends.
///   Phase 3 (Closed):    anyone tallies after the voting deadline
///
/// @dev Trust model (read before relying on this contract):
///   - Signup is public: anyone can see which identity commitments registered.
///   - Eligibility: in open elections (`selfSignupAllowed`) anyone can sign up. In gated
///     elections only the admin and the `registrar` can register voters. The registrar is
///     normally the Spectre relay, which checks an off-chain gate (invite code, allowlist,
///     email, SSO, token balance) before registering. The registrar is therefore trusted
///     for eligibility in gated elections. A non-zero `gateKey` lets each credential
///     register at most once, enforced here on-chain. `maxVoters` and `maxWeight`, fixed at
///     creation, bound what any registrar (or a leaked registrar key) can add.
///   - Ballot secrecy: nobody holds an election key. Clients encrypt ballots off-chain with
///     drand time-lock encryption to a round after the voting deadline, so until then no one
///     (admin included) can read them, assuming the drand network's threshold holds. After
///     that anyone can decrypt every ballot and recount. Opened ballots are public; they
///     are unlinkable to signups on-chain, but whoever submits joins and ballots for voters
///     (the relay) sees their network addresses and can link them.
///   - The contract never sees plaintext votes and doesn't check the ciphertext, so the
///     submitter could replace a ballot's ciphertext; voters' clients check what landed.
///   - Not coercion-resistant: overwrites share a public base nullifier, and voters can
///     open their own vote commitments.
///   - Two Semaphore groups per election: `signupGroupId` (Phase 1) and `votingGroupId`
///     (Phase 2, populated by AnonJoin proofs). Leaves are Poseidon(commitment, weight).
contract SpectreVoting {
    uint256 public constant VERSION = 9;
    uint256 public constant MAX_WEIGHT = 255;
    /// Most voters an election can register (capacity of the circuits' depth-20 Merkle trees)
    uint256 public constant MAX_VOTERS_LIMIT = 1 << 20;
    /// Largest ballot ciphertext accepted (sealed ballots are about 600 bytes)
    uint256 public constant MAX_BALLOT_BYTES = 1024;

    /// Election settings, fixed at creation
    struct Config {
        uint256 proposalId;
        uint256 signupDeadline;   // required, in the future, before votingDeadline
        uint256 votingDeadline;   // required; ballots are time-locked to it
        uint256 numOptions;       // 2..255
        uint256 maxVoters;        // 1..MAX_VOTERS_LIMIT: cap on all registrations
        uint256 maxWeight;        // 1..MAX_WEIGHT: largest weight a voter can be registered with
        bool selfSignupAllowed;   // open election (anyone can signUp) vs gated
        address registrar;        // may register voters in gated elections (normally the relay), or 0
    }

    ISemaphore public semaphore;
    ISpectreVoteVerifier public voteVerifier;
    IAnonJoinVerifier public joinVerifier;

    uint256 public signupGroupId;
    uint256 public votingGroupId;
    uint256 public proposalId;

    // Multi-option voting: numOptions choices (e.g. 2 for yes/no, 4 for multi)
    uint256 public numOptions;

    // Election state & phase management
    //   Phase 1: signupOpen = true,  votingOpen = false
    //   Phase 2: signupOpen = false, votingOpen = true
    //   Phase 3: signupOpen = false, votingOpen = false
    bool public signupOpen;
    bool public votingOpen;
    address public admin;

    // Address allowed to register voters alongside the admin (normally the Spectre relay)
    address public registrar;

    // Access control: when false, only the admin or registrar can register voters (gated mode)
    bool public selfSignupAllowed;

    // Phase deadlines
    uint256 public signupDeadline;  // signup ends here at the latest; voting then opens on its own
    uint256 public votingDeadline;  // required; ballots are time-locked to this moment

    // Registration limits
    uint256 public maxVoters;           // cap on registrations of any kind
    uint256 public maxWeight;           // largest weight registerVoter accepts
    uint256 public registrationCount;   // registrations so far

    // Block this election was created in (lower bound for event scans)
    uint256 public immutable deployBlock;

    // One registration per gate credential (keyed hash chosen by the registrar)
    mapping(bytes32 => bool) public usedGateKeys;

    // Versioned nullifier dedup for votes (vote overwriting)
    mapping(uint256 => bool) public usedNullifiers;      // versionedNullifier → used
    mapping(uint256 => bool) public knownVoters;         // baseNullifier → has voted at least once
    uint256 public uniqueVoterCount;                     // distinct voters (not counting overwrites)

    // AnonJoin nullifier dedup (prevents double-joining)
    mapping(uint256 => bool) public usedJoinNullifiers;

    // Vote storage
    uint256 public voteCount;                            // total submissions (including overwrites)

    // Tally result commitment (Phase 3: set once by the admin after a recount)
    bool public tallyCommitted;
    uint256 public tallyPoseidonCommitment;
    uint256 public tallyTotalValid;
    uint256 public tallyTotalInvalid;
    uint256[] public tallyOptionCounts;

    event ElectionCreated(
        uint256 indexed signupGroupId,
        uint256 indexed votingGroupId,
        uint256 indexed proposalId,
        uint256 numOptions
    );

    event VoterSignedUp(
        uint256 indexed signupGroupId,
        uint256 identityCommitment,
        uint256 weight
    );

    event AnonJoined(
        uint256 indexed votingGroupId,
        uint256 joinNullifier,
        uint256 newCommitment
    );

    event VoteCast(
        uint256 indexed proposalId,
        uint256 indexed baseNullifier,
        uint256 versionedNullifier,
        uint256 voteCommitment,
        bytes encryptedBlob
    );

    event RegistrarChanged(address indexed previousRegistrar, address indexed newRegistrar);
    event SignupClosed(uint256 indexed proposalId);
    event VotingClosed(uint256 indexed proposalId, uint256 totalVotes);
    event TallyCommitted(uint256 indexed proposalId, uint256 poseidonCommitment, uint256 totalValid, uint256 totalInvalid, uint256[] optionCounts);

    error NotAdmin();
    error NotAuthorized();
    error SignupNotOpen();
    error VotingNotOpen();
    error VotingAlreadyOpen();
    error SignupAlreadyClosed();
    error NullifierAlreadyUsed();
    error JoinNullifierAlreadyUsed();
    error InvalidProof();
    error MerkleRootMismatch();
    error InvalidCommitment();
    error InvalidWeight();
    error GateKeyAlreadyUsed();
    error InvalidGateKey();
    error InvalidDeadlines();
    error VotingDeadlinePassed();
    error VotingNotEnded();
    error SignupDeadlinePassed();
    error SignupStillOpen();
    error InvalidNumOptions();
    error SelfSignupNotAllowed();
    error TallyAlreadyCommitted();
    error VotingStillOpen();
    error InvalidOptionCount();
    error InvalidMaxVoters();
    error TooManyVoters();
    error BallotTooLarge();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAdminOrRegistrar() {
        if (msg.sender != admin && msg.sender != registrar) revert NotAuthorized();
        _;
    }

    modifier whenSignupOpen() {
        if (!signupOpen) revert SignupNotOpen();
        if (block.timestamp > signupDeadline) revert SignupDeadlinePassed();
        _;
    }

    modifier whenVotingOpen() {
        _openVotingIfSignupEnded();
        if (!votingOpen) revert VotingNotOpen();
        if (block.timestamp > votingDeadline) revert VotingDeadlinePassed();
        _;
    }

    /// @param _admin Election admin (address(0) = the deployer)
    /// @param _config Deadlines, options, limits, signup mode and registrar; see `Config`
    constructor(
        address _semaphore,
        address _voteVerifier,
        address _joinVerifier,
        address _admin,
        Config memory _config
    ) {
        if (_config.numOptions < 2 || _config.numOptions > 255) revert InvalidNumOptions();
        if (_config.votingDeadline <= block.timestamp) revert InvalidDeadlines();
        if (_config.signupDeadline <= block.timestamp || _config.signupDeadline >= _config.votingDeadline) {
            revert InvalidDeadlines();
        }
        if (_config.maxVoters == 0 || _config.maxVoters > MAX_VOTERS_LIMIT) revert InvalidMaxVoters();
        if (_config.maxWeight == 0 || _config.maxWeight > MAX_WEIGHT) revert InvalidWeight();

        semaphore = ISemaphore(_semaphore);
        voteVerifier = ISpectreVoteVerifier(_voteVerifier);
        joinVerifier = IAnonJoinVerifier(_joinVerifier);
        admin = _admin == address(0) ? msg.sender : _admin;
        proposalId = _config.proposalId;
        signupDeadline = _config.signupDeadline;
        votingDeadline = _config.votingDeadline;
        numOptions = _config.numOptions;
        maxVoters = _config.maxVoters;
        maxWeight = _config.maxWeight;
        selfSignupAllowed = _config.selfSignupAllowed;
        deployBlock = block.number;

        if (_config.registrar != address(0)) {
            registrar = _config.registrar;
            emit RegistrarChanged(address(0), _config.registrar);
        }

        // Create two Semaphore groups; this contract becomes the group admin for both
        signupGroupId = semaphore.createGroup();
        votingGroupId = semaphore.createGroup();

        // Start in Phase 1: signup open, voting closed
        signupOpen = true;
        votingOpen = false;

        emit ElectionCreated(signupGroupId, votingGroupId, _config.proposalId, _config.numOptions);
    }

    // =======================================================================
    // Phase 1: Signup (public registration)
    // =======================================================================

    /// @notice Self-register during the signup phase. Only available when selfSignupAllowed is true.
    /// @param identityCommitment Poseidon(BabyJubJub_pubkey): the voter's signup identity
    /// @dev Stores Poseidon(identityCommitment, 1) as the weighted leaf for the AnonJoin circuit
    function signUp(uint256 identityCommitment) external whenSignupOpen {
        if (!selfSignupAllowed) revert SelfSignupNotAllowed();
        _register(identityCommitment, 1);
    }

    /// @notice Register one voter with a weight, optionally consuming a gate credential.
    /// @dev Callable by the admin or the registrar. The registrar enforces off-chain gates;
    ///      `gateKey` (a keyed hash of the credential, or zero for none) can be used only once.
    /// @param identityCommitment The voter's signup identity commitment
    /// @param weight Voting weight, 1..MAX_WEIGHT
    /// @param gateKey Hash identifying the credential used to register, or bytes32(0)
    function registerVoter(uint256 identityCommitment, uint256 weight, bytes32 gateKey)
        external
        onlyAdminOrRegistrar
        whenSignupOpen
    {
        if (weight == 0 || weight > maxWeight) revert InvalidWeight();
        if (gateKey == bytes32(0)) {
            // The registrar enforces one registration per credential, so it must always name one.
            // Only the admin may register without a gate key (manual registration).
            if (msg.sender != admin) revert InvalidGateKey();
        } else {
            if (usedGateKeys[gateKey]) revert GateKeyAlreadyUsed();
            usedGateKeys[gateKey] = true;
        }
        _register(identityCommitment, weight);
    }

    /// @notice Admin registers multiple voters at once (weight 1, no gate key)
    function registerVoters(uint256[] calldata identityCommitments) external onlyAdmin whenSignupOpen {
        if (registrationCount + identityCommitments.length > maxVoters) revert TooManyVoters();
        registrationCount += identityCommitments.length;
        uint256[] memory weightedLeaves = new uint256[](identityCommitments.length);
        for (uint256 i = 0; i < identityCommitments.length; i++) {
            if (identityCommitments[i] == 0) revert InvalidCommitment();
            weightedLeaves[i] = PoseidonT3.hash([identityCommitments[i], 1]);
        }
        semaphore.addMembers(signupGroupId, weightedLeaves);
        for (uint256 i = 0; i < identityCommitments.length; i++) {
            emit VoterSignedUp(signupGroupId, identityCommitments[i], 1);
        }
    }

    /// @notice Change the registrar (e.g. after rotating the relay key). address(0) disables it.
    function setRegistrar(address newRegistrar) external onlyAdmin {
        emit RegistrarChanged(registrar, newRegistrar);
        registrar = newRegistrar;
    }

    /// @notice Close signup and open voting. The admin can close early; after the signup
    ///         deadline anyone can, though the first join or vote does it anyway.
    function closeSignup() external {
        if (!signupOpen) revert SignupAlreadyClosed();
        // Admin can always close. Others can only close after the signup deadline.
        if (msg.sender != admin && block.timestamp <= signupDeadline) revert NotAdmin();
        signupOpen = false;
        votingOpen = true;
        emit SignupClosed(proposalId);
    }

    /// @dev Signup ends at its deadline even if nobody calls closeSignup: the first join,
    ///      vote or closeVoting after the deadline opens voting. So nobody (including the
    ///      admin) can keep voting from opening on time.
    function _openVotingIfSignupEnded() internal {
        if (signupOpen && block.timestamp > signupDeadline) {
            signupOpen = false;
            votingOpen = true;
            emit SignupClosed(proposalId);
        }
    }

    function _register(uint256 identityCommitment, uint256 weight) internal {
        if (identityCommitment == 0) revert InvalidCommitment();
        if (registrationCount >= maxVoters) revert TooManyVoters();
        registrationCount++;
        uint256 weightedLeaf = PoseidonT3.hash([identityCommitment, weight]);
        semaphore.addMember(signupGroupId, weightedLeaf);
        emit VoterSignedUp(signupGroupId, identityCommitment, weight);
    }

    // =======================================================================
    // Phase 2: Anonymous Join + Vote
    // =======================================================================

    /// @notice Anonymously join the voting group with a ZK re-key proof.
    ///         Proves membership in the signup group without revealing which member,
    ///         and outputs a new delinked voting commitment.
    /// @param pA Groth16 proof point A
    /// @param pB Groth16 proof point B
    /// @param pC Groth16 proof point C
    /// @param signupRoot The signup Merkle root the proof was generated against
    /// @param joinNullifier Poseidon(electionId, secret): prevents double-joining
    /// @param newCommitment New weighted voting commitment (delinked from signup)
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
    /// @param baseNullifier Poseidon(proposalId, secret): deterministic per voter (tally dedup)
    /// @param versionedNullifier Poseidon(proposalId, secret, version): unique per submission
    /// @param voteCommitment Poseidon(vote, weight, randomness): binds the encrypted vote to the proof
    /// @param encryptedBlob Ballot (vote, weight, randomness) time-locked to after the voting deadline.
    ///        Its contents aren't checked on-chain (only its size); the recount checks it against voteCommitment.
    function castVote(
        uint[2] calldata pA,
        uint[2][2] calldata pB,
        uint[2] calldata pC,
        uint256 merkleTreeRoot,
        uint256 baseNullifier,
        uint256 versionedNullifier,
        uint256 voteCommitment,
        bytes calldata encryptedBlob
    ) external whenVotingOpen {
        // Oversized logs would make the ballots hard to fetch for everyone's recount
        if (encryptedBlob.length > MAX_BALLOT_BYTES) revert BallotTooLarge();

        // 1. Check versioned nullifier hasn't been used (prevents replay of same version)
        if (usedNullifiers[versionedNullifier]) revert NullifierAlreadyUsed();

        // 2. Verify the Merkle root is valid for the voting group
        if (ISemaphoreGroups(address(semaphore)).getMerkleTreeRoot(votingGroupId) != merkleTreeRoot) {
            revert MerkleRootMismatch();
        }

        // 3. Verify the ZK proof
        //    Public signals: [merkleRoot, baseNullifier, versionedNullifier, voteCommitment, proposalId, numOptions]
        uint[6] memory pubSignals = [
            merkleTreeRoot,
            baseNullifier,
            versionedNullifier,
            voteCommitment,
            proposalId,
            numOptions
        ];

        bool valid = voteVerifier.verifyProof(pA, pB, pC, pubSignals);
        if (!valid) revert InvalidProof();

        // 4. Update state
        usedNullifiers[versionedNullifier] = true;
        if (!knownVoters[baseNullifier]) {
            knownVoters[baseNullifier] = true;
            uniqueVoterCount++;
        }
        voteCount++;

        // 5. Emit vote data (encrypted blob stored as event log)
        emit VoteCast(proposalId, baseNullifier, versionedNullifier, voteCommitment, encryptedBlob);
    }

    /// @notice Close voting. Anyone can call it, but only after the voting deadline;
    ///         nobody (including the admin) can end voting early.
    function closeVoting() external {
        _openVotingIfSignupEnded();
        if (!votingOpen) revert VotingNotOpen();
        if (block.timestamp <= votingDeadline) revert VotingNotEnded();
        votingOpen = false;
        emit VotingClosed(proposalId, voteCount);
    }

    // =======================================================================
    // Phase 3: Tally Commitment (admin publishes the recount on-chain)
    // =======================================================================

    /// @notice Commit the tally result on-chain. Can only be called once.
    /// @dev This records the admin's numbers; it doesn't prove them. Because ballots
    ///      become decryptable by anyone after the deadline, anyone can recount and
    ///      compare. The poseidonCommitment is a hash chain computed off-chain:
    ///      h = poseidon2(totalValid, totalInvalid)
    ///      for each optionCount: h = poseidon2(h, optionCount)
    /// @param optionCounts  Per-option vote counts (length must match numOptions)
    /// @param totalValid    Total number of valid votes
    /// @param totalInvalid  Total number of invalid votes
    /// @param poseidonCommitment  Poseidon hash chain of the tally data
    function commitTallyResult(
        uint256[] calldata optionCounts,
        uint256 totalValid,
        uint256 totalInvalid,
        uint256 poseidonCommitment
    ) external onlyAdmin {
        if (signupOpen) revert SignupStillOpen();
        if (votingOpen) revert VotingStillOpen();
        if (tallyCommitted) revert TallyAlreadyCommitted();
        if (optionCounts.length != numOptions) revert InvalidOptionCount();

        tallyCommitted = true;
        tallyPoseidonCommitment = poseidonCommitment;
        tallyTotalValid = totalValid;
        tallyTotalInvalid = totalInvalid;
        tallyOptionCounts = optionCounts;

        emit TallyCommitted(proposalId, poseidonCommitment, totalValid, totalInvalid, optionCounts);
    }

    /// @notice Read the committed option counts array
    /// @return The full tallyOptionCounts array
    function getTallyOptionCounts() external view returns (uint256[] memory) {
        return tallyOptionCounts;
    }
}
