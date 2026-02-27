//SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./SpectreVoting.sol";

/// @title SpectreVotingFactory — Deploy new elections on demand
/// @notice Anyone can create an election. The caller becomes the election admin.
///         Semaphore + Groth16Verifier are shared infrastructure set at factory deploy time.
contract SpectreVotingFactory {
    address public immutable semaphore;
    address public immutable verifier;

    // Registry of all deployed elections
    address[] public elections;
    mapping(address => bool) public isElection;

    event ElectionDeployed(
        address indexed election,
        address indexed admin,
        uint256 proposalId,
        uint256 electionPubKeyX,
        uint256 electionPubKeyY
    );

    constructor(address _semaphore, address _verifier) {
        semaphore = _semaphore;
        verifier = _verifier;
    }

    /// @notice Deploy a new SpectreVoting election
    /// @param _proposalId Unique proposal identifier
    /// @param _electionPubKeyX Election ECIES public key X coordinate
    /// @param _electionPubKeyY Election ECIES public key Y coordinate
    /// @param _votingDeadline Unix timestamp when voting closes (0 = no deadline, admin-only close)
    /// @return election The address of the newly deployed SpectreVoting contract
    function createElection(
        uint256 _proposalId,
        uint256 _electionPubKeyX,
        uint256 _electionPubKeyY,
        uint256 _votingDeadline
    ) external returns (address election) {
        // Pass msg.sender as _admin so the caller (not the factory) is admin
        SpectreVoting sv = new SpectreVoting(
            semaphore,
            verifier,
            _proposalId,
            _electionPubKeyX,
            _electionPubKeyY,
            msg.sender,
            _votingDeadline
        );

        election = address(sv);
        elections.push(election);
        isElection[election] = true;

        emit ElectionDeployed(election, msg.sender, _proposalId, _electionPubKeyX, _electionPubKeyY);
    }

    /// @notice Get the total number of elections created
    function electionCount() external view returns (uint256) {
        return elections.length;
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
