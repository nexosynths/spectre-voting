/**
 * Human-readable error messages for SpectreVoting contract custom errors.
 *
 * Maps Solidity error names → user-friendly strings. The friendlyError()
 * helper extracts the error name from ethers.js v6 error objects and
 * returns the mapped message (or a cleaned-up fallback).
 */

import { Interface } from "ethers"
import { SPECTRE_VOTING_ABI } from "./contracts"

/** Map of custom error names → human-readable messages */
const ERROR_MESSAGES: Record<string, string> = {
    NotAdmin: "Only the election admin can perform this action",
    SignupNotOpen: "Signup is not open",
    VotingNotOpen: "Voting is not open yet (or has already closed)",
    VotingAlreadyOpen: "Voting is already open",
    SignupAlreadyClosed: "Signup has already been closed",
    NullifierAlreadyUsed: "You've already voted in this election",
    JoinNullifierAlreadyUsed: "You've already joined the voting group",
    InvalidProof: "ZK proof verification failed — please try again",
    MerkleRootMismatch: "Group membership is stale — try refreshing the page",
    InvalidCommitment: "Identity commitment is invalid",
    VotingDeadlinePassed: "The voting deadline has passed",
    SignupDeadlinePassed: "The signup deadline has passed",
    SignupStillOpen: "Signup must be closed before opening voting",
    InvalidNumOptions: "Invalid number of voting options",
    SelfSignupNotAllowed: "Self-signup is disabled — only the admin can register voters",
    TallyAlreadyCommitted: "The tally has already been committed for this election",
    VotingStillOpen: "Voting must be closed before committing the tally",
    InvalidOptionCount: "Option counts array length doesn't match the election's numOptions",
}

// Lazy-init interface for manual selector decoding
let iface: Interface | null = null
function getInterface(): Interface {
    if (!iface) iface = new Interface(SPECTRE_VOTING_ABI)
    return iface
}

/**
 * Extract a human-readable error message from an ethers.js v6 error.
 *
 * Tries multiple strategies in order:
 *   1. err.revert?.name — ethers v6 CALL_EXCEPTION parsed error
 *   2. err.reason — sometimes contains the decoded error name
 *   3. err.data — raw 4-byte selector, manually decoded via Interface
 *   4. Substring match on err.message for known error names
 *   5. Fallback: user action was rejected (code 4001/ACTION_REJECTED)
 *   6. Fallback: cleaned-up err.message
 */
export function friendlyError(err: any): string {
    // Strategy 1: ethers v6 puts parsed custom error in err.revert
    if (err?.revert?.name && ERROR_MESSAGES[err.revert.name]) {
        return ERROR_MESSAGES[err.revert.name]
    }

    // Strategy 2: err.reason sometimes contains the error name
    if (err?.reason) {
        const name = err.reason.replace("execution reverted: ", "")
        if (ERROR_MESSAGES[name]) return ERROR_MESSAGES[name]
    }

    // Strategy 3: decode raw error data via Interface.parseError()
    if (err?.data && typeof err.data === "string" && err.data.length >= 10) {
        try {
            const parsed = getInterface().parseError(err.data)
            if (parsed && ERROR_MESSAGES[parsed.name]) {
                return ERROR_MESSAGES[parsed.name]
            }
        } catch {
            // Not a known selector — continue to fallback
        }
    }

    // Also check nested error info (ethers v6 sometimes wraps errors)
    const info = err?.info?.error
    if (info?.data && typeof info.data === "string" && info.data.length >= 10) {
        try {
            const parsed = getInterface().parseError(info.data)
            if (parsed && ERROR_MESSAGES[parsed.name]) {
                return ERROR_MESSAGES[parsed.name]
            }
        } catch {
            // continue
        }
    }

    // Strategy 4: substring match on err.message for known error names
    const msg = err?.message || ""
    for (const [name, friendly] of Object.entries(ERROR_MESSAGES)) {
        if (msg.includes(name)) return friendly
    }

    // Strategy 5: user rejected the transaction in their wallet
    if (err?.code === "ACTION_REJECTED" || err?.code === 4001 || msg.includes("user rejected")) {
        return "Transaction was rejected in your wallet"
    }

    // Strategy 6: cleaned-up fallback
    if (err?.reason) return err.reason
    if (msg.length > 200) return msg.slice(0, 180) + "…"
    return msg || "Unknown error"
}
