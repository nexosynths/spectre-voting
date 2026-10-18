//SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./SpectreVoting.sol";

/// @title SpectreVotingFactory: deploy new elections on demand
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
        uint256 signupDeadline,
        uint256 votingDeadline,
        uint256 numOptions,
        bool selfSignupAllowed,
        address registrar,
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
    /// @param _config Election settings (see SpectreVoting.Config):
    ///        proposalId; signupDeadline (required, in the future); votingDeadline (after the
    ///        signup deadline); numOptions (2..255); maxVoters (cap on registrations);
    ///        maxWeight (1 unless weighted); selfSignupAllowed (open vs gated); registrar
    ///        (normally the Spectre relay for gated elections, or address(0))
    /// @param _metadata Opaque bytes (UTF-8 JSON) with election title, labels and gate config. Emitted in the event only.
    /// @return election The address of the newly deployed SpectreVoting contract
    function createElection(
        SpectreVoting.Config calldata _config,
        bytes calldata _metadata
    ) external payable returns (address election) {
        require(msg.value >= creationFee, "Insufficient fee");
        if (msg.value > creationFee) {
            (bool sent, ) = msg.sender.call{value: msg.value - creationFee}("");
            require(sent, "Refund failed");
        }
        // Pass msg.sender as _admin so the caller (not the factory) is admin
        election = address(new SpectreVoting(semaphore, voteVerifier, joinVerifier, msg.sender, _config));
        elections.push(election);
        isElection[election] = true;

        emit ElectionDeployed(
            election,
            msg.sender,
            _config.proposalId,
            _config.signupDeadline,
            _config.votingDeadline,
            _config.numOptions,
            _config.selfSignupAllowed,
            _config.registrar,
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
