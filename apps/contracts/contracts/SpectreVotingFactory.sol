//SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./SpectreVoting.sol";

/// @title SpectreVotingFactory — Deploy new elections on demand
/// @notice Anyone can create an election. The caller becomes the election admin.
///         Semaphore + both verifiers are shared infrastructure set at factory deploy time.
contract SpectreVotingFactory {
    address public immutable semaphore;
    address public immutable voteVerifier;
    address public immutable joinVerifier;

    uint256 public creationFee;
    address public owner;

    // Registry of all deployed elections
    address[] public elections;
    mapping(address => bool) public isElection;

    event ElectionDeployed(
        address indexed election,
        address indexed admin,
        uint256 proposalId,
        uint256 electionPubKeyX,
        uint256 electionPubKeyY,
        uint256 signupDeadline,
        uint256 votingDeadline,
        uint256 numOptions,
        bool selfSignupAllowed,
        bytes metadata
    );

    constructor(address _semaphore, address _voteVerifier, address _joinVerifier) {
        semaphore = _semaphore;
        voteVerifier = _voteVerifier;
        joinVerifier = _joinVerifier;
        creationFee = 0.001 ether;
        owner = msg.sender;
    }

    /// @notice Deploy a new SpectreVoting election
    /// @param _proposalId Unique proposal identifier
    /// @param _electionPubKeyX Election ECIES public key X coordinate
    /// @param _electionPubKeyY Election ECIES public key Y coordinate
    /// @param _signupDeadline Unix timestamp when signup closes (0 = no deadline, admin-only close)
    /// @param _votingDeadline Unix timestamp when voting closes (0 = no deadline, admin-only close)
    /// @param _numOptions Number of vote options (minimum 2)
    /// @param _selfSignupAllowed When true, anyone can self-register; when false, only admin can register voters
    /// @param _metadata Opaque bytes (UTF-8 JSON) with election title, labels, threshold info. Emitted in event only.
    /// @return election The address of the newly deployed SpectreVoting contract
    function createElection(
        uint256 _proposalId,
        uint256 _electionPubKeyX,
        uint256 _electionPubKeyY,
        uint256 _signupDeadline,
        uint256 _votingDeadline,
        uint256 _numOptions,
        bool _selfSignupAllowed,
        bytes calldata _metadata
    ) external payable returns (address election) {
        require(msg.value >= creationFee, "Insufficient fee");
        if (msg.value > creationFee) {
            (bool sent, ) = msg.sender.call{value: msg.value - creationFee}("");
            require(sent, "Refund failed");
        }
        // Pass msg.sender as _admin so the caller (not the factory) is admin
        SpectreVoting sv = new SpectreVoting(
            semaphore,
            voteVerifier,
            joinVerifier,
            _proposalId,
            _electionPubKeyX,
            _electionPubKeyY,
            msg.sender,
            _signupDeadline,
            _votingDeadline,
            _numOptions,
            _selfSignupAllowed
        );

        election = address(sv);
        elections.push(election);
        isElection[election] = true;

        emit ElectionDeployed(
            election,
            msg.sender,
            _proposalId,
            _electionPubKeyX,
            _electionPubKeyY,
            _signupDeadline,
            _votingDeadline,
            _numOptions,
            _selfSignupAllowed,
            _metadata
        );
    }

    /// @notice Get the total number of elections created
    function electionCount() external view returns (uint256) {
        return elections.length;
    }

    /// @notice Withdraw collected fees to the owner
    function withdraw() external {
        require(msg.sender == owner, "Not owner");
        (bool sent, ) = owner.call{value: address(this).balance}("");
        require(sent, "Withdraw failed");
    }

    /// @notice Update the election creation fee
    function setCreationFee(uint256 _fee) external {
        require(msg.sender == owner, "Not owner");
        creationFee = _fee;
    }

    /// @notice Get a page of election addresses
    /// @param offset Start index
    /// @param limit Max number of results
    function getElections(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 total = elections.length;
        if (offset >= total) {
            return new address[](0);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        address[] memory result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = elections[offset + i];
        }
        return result;
    }
}
