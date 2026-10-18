/**
 * Public recount: anyone can open the time-locked ballots after the deadline,
 * check each one against its on-chain vote commitment, and count.
 */

import { poseidon2, poseidon3 } from "poseidon-lite"
import { openBallots, decodeVotePayload, hexToBytes, type BeaconFetcher } from "@/lib/ballot"
import type { ChainInfo } from "tlock-js"

/** One VoteCast event, as read from the chain. */
export interface BallotRecord {
    baseNullifier: string
    voteCommitment: string
    encryptedBlob: string // hex
}

export interface CountedBallot {
    baseNullifier: string
    vote: bigint
    weight: bigint
    commitmentValid: boolean
    problem?: string
}

export interface TallyResult {
    optionCounts: number[]
    totalValid: number
    totalInvalid: number
    duplicatesRemoved: number
    ballots: CountedBallot[]
}

/**
 * Open and count ballots. Records must be in chain order: for each voter
 * (baseNullifier) the last submission counts.
 */
export async function countBallots(
    records: BallotRecord[],
    numOptions: number,
    votingDeadline: number,
    options: { chain?: ChainInfo; fetchBeacon?: BeaconFetcher; now?: number } = {},
): Promise<TallyResult> {
    const opened = records.length > 0
        ? await openBallots(records.map(r => hexToBytes(r.encryptedBlob)), votingDeadline, options)
        : []

    const counted: CountedBallot[] = records.map((record, i) => {
        const result = opened[i]
        if (!result.ok) {
            return { baseNullifier: record.baseNullifier, vote: -1n, weight: 0n, commitmentValid: false, problem: result.reason }
        }
        try {
            const { vote, weight, voteRandomness } = decodeVotePayload(result.payload)
            const commitmentValid = poseidon3([vote, weight, voteRandomness]).toString() === record.voteCommitment
            return {
                baseNullifier: record.baseNullifier,
                vote,
                weight,
                commitmentValid,
                problem: commitmentValid ? undefined : "Ballot doesn't match its on-chain commitment",
            }
        } catch (err) {
            return {
                baseNullifier: record.baseNullifier, vote: -1n, weight: 0n, commitmentValid: false,
                problem: err instanceof Error ? err.message : "Malformed ballot",
            }
        }
    })

    // Last submission per voter wins (vote overwriting)
    const latest = new Map<string, CountedBallot>()
    let duplicatesRemoved = 0
    for (const ballot of counted) {
        if (latest.has(ballot.baseNullifier)) duplicatesRemoved++
        latest.set(ballot.baseNullifier, ballot)
    }

    const ballots = Array.from(latest.values())
    const optionCounts = new Array(numOptions).fill(0)
    let totalInvalid = 0
    for (const ballot of ballots) {
        if (!ballot.commitmentValid || ballot.vote < 0n || ballot.vote >= BigInt(numOptions) || ballot.weight < 1n) {
            totalInvalid++
        } else {
            optionCounts[Number(ballot.vote)] += Number(ballot.weight)
        }
    }
    const totalValid = optionCounts.reduce((a: number, b: number) => a + b, 0)

    return { optionCounts, totalValid, totalInvalid, duplicatesRemoved, ballots }
}

/** Poseidon hash chain stored by commitTallyResult: h = P(valid, invalid); h = P(h, count_i). */
export function tallyCommitment(optionCounts: number[], totalValid: number, totalInvalid: number): bigint {
    let hash = poseidon2([BigInt(totalValid), BigInt(totalInvalid)])
    for (const count of optionCounts) hash = poseidon2([hash, BigInt(count)])
    return hash
}

/** Does an on-chain committed tally match a recount? */
export function commitmentMatches(
    committed: { poseidonCommitment: string; totalValid: number; totalInvalid: number; optionCounts: number[] },
    recount: TallyResult,
): boolean {
    if (committed.totalValid !== recount.totalValid || committed.totalInvalid !== recount.totalInvalid) return false
    if (committed.optionCounts.length !== recount.optionCounts.length) return false
    if (committed.optionCounts.some((c, i) => c !== recount.optionCounts[i])) return false
    return tallyCommitment(recount.optionCounts, recount.totalValid, recount.totalInvalid).toString() === committed.poseidonCommitment
}
