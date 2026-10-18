/**
 * Reading Spectre elections from the chain: event scans in block chunks, election
 * metadata, group members and ballots. Used by the browser and by the API routes.
 *
 * Scans start at the election's own deploy block, so they don't depend on a
 * hard-coded factory block. Queries always ask for every event of a kind and filter
 * locally, never for one voter's nullifier or transaction. The RPC provider still
 * sees the client's IP address and when it asks, which can hint at which record it
 * cares about when few events are recent.
 */

import { Contract, JsonRpcProvider, toUtf8String, type ContractEventName, type EventLog, type Log } from "ethers"
import { CONTRACTS, FACTORY_ABI, SPECTRE_VOTING_ABI, SEMAPHORE_ABI, MAX_LOG_RANGE } from "@/lib/contracts"

const SCAN_CONCURRENCY = 4

/** Query an event over [fromBlock, toBlock] in chunks the RPC accepts; results in chain order. */
export async function queryInChunks(
    contract: Contract,
    filter: ContractEventName,
    fromBlock: number,
    toBlock: number,
): Promise<EventLog[]> {
    if (toBlock < fromBlock) return []
    const ranges: [number, number][] = []
    for (let from = fromBlock; from <= toBlock; from += MAX_LOG_RANGE) {
        ranges.push([from, Math.min(from + MAX_LOG_RANGE - 1, toBlock)])
    }
    const results: (EventLog | Log)[][] = new Array(ranges.length)
    let next = 0
    async function worker() {
        while (next < ranges.length) {
            const i = next++
            results[i] = await contract.queryFilter(filter, ranges[i][0], ranges[i][1])
        }
    }
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, ranges.length) }, worker))
    const events = results.flat().filter((e): e is EventLog => "args" in e && !!(e as EventLog).args)
    events.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    return events
}

/** The block an election was created in (lower bound for its event scans). */
export async function electionDeployBlock(electionAddress: string, provider: JsonRpcProvider): Promise<number> {
    const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
    return Number(await election.deployBlock())
}

/**
 * Election metadata (title, labels, gate config) from the factory's ElectionDeployed event.
 * Only the factory's own events count, so a contract that isn't a factory election has none.
 */
export async function fetchElectionMetadata(
    electionAddress: string,
    provider: JsonRpcProvider,
): Promise<Record<string, any> | null> {
    try {
        const deployBlock = await electionDeployBlock(electionAddress, provider)
        const factory = new Contract(CONTRACTS.FACTORY, FACTORY_ABI, provider)
        const events = await factory.queryFilter(factory.filters.ElectionDeployed(electionAddress), deployBlock, deployBlock)
        const event = events.find((e): e is EventLog => "args" in e)
        if (!event) return null
        const raw: string = event.args.metadata
        if (!raw || raw === "0x" || raw.length <= 2) return null
        return JSON.parse(toUtf8String(raw))
    } catch {
        return null
    }
}

/** Members of a Semaphore group, in insertion order. */
export async function fetchGroupMembers(
    provider: JsonRpcProvider,
    groupId: bigint,
    fromBlock: number,
    toBlock?: number,
): Promise<bigint[]> {
    const sem = new Contract(CONTRACTS.SEMAPHORE, SEMAPHORE_ABI, provider)
    const latest = toBlock ?? await provider.getBlockNumber()
    const [singles, bulks] = await Promise.all([
        queryInChunks(sem, sem.filters.MemberAdded(groupId), fromBlock, latest),
        queryInChunks(sem, sem.filters.MembersAdded(groupId), fromBlock, latest),
    ])
    const members: { index: number; commitment: bigint }[] = []
    for (const e of singles) members.push({ index: Number(e.args.index), commitment: BigInt(e.args.identityCommitment) })
    for (const e of bulks) {
        const start = Number(e.args.startIndex)
        e.args.identityCommitments.forEach((c: bigint, i: number) => members.push({ index: start + i, commitment: BigInt(c) }))
    }
    members.sort((a, b) => a.index - b.index)
    return members.map(m => m.commitment)
}

export interface SignupRecord {
    identityCommitment: bigint
    weight: bigint
}

/** Every registration in an election (VoterSignedUp), in chain order. */
export async function fetchSignups(
    electionAddress: string,
    provider: JsonRpcProvider,
    fromBlock: number,
    toBlock?: number,
): Promise<SignupRecord[]> {
    const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
    const latest = toBlock ?? await provider.getBlockNumber()
    const events = await queryInChunks(election, election.filters.VoterSignedUp(), fromBlock, latest)
    return events.map(e => ({ identityCommitment: BigInt(e.args.identityCommitment), weight: BigInt(e.args.weight) }))
}

/** One VoteCast event, as read from the chain. */
export interface BallotRecord {
    baseNullifier: string
    versionedNullifier: string
    voteCommitment: string
    encryptedBlob: string // hex
}

/** Every ballot cast in an election over [fromBlock, toBlock], in chain order. */
export async function fetchBallots(
    electionAddress: string,
    provider: JsonRpcProvider,
    fromBlock: number,
    toBlock: number,
): Promise<BallotRecord[]> {
    const election = new Contract(electionAddress, SPECTRE_VOTING_ABI, provider)
    const events = await queryInChunks(election, election.filters.VoteCast(), fromBlock, toBlock)
    return events.map(e => ({
        baseNullifier: e.args.baseNullifier.toString(),
        versionedNullifier: e.args.versionedNullifier.toString(),
        voteCommitment: e.args.voteCommitment.toString(),
        encryptedBlob: String(e.args.encryptedBlob).toLowerCase(),
    }))
}
