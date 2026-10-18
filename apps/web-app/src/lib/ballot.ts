/**
 * Ballot sealing with drand time-lock encryption (tlock).
 *
 * Each ballot is encrypted to a future round of drand's quicknet beacon: the
 * first round published after the election's voting deadline. Nobody holds a
 * decryption key. Before that round is published, nobody can read a ballot,
 * including the election admin. After it is published, anyone can decrypt
 * every ballot and recount.
 *
 * Trust assumption: drand's League of Entropy network (a threshold of
 * independent operators) does not publish or leak the round signature early.
 * Ballots become public after the deadline; they are anonymous only because
 * of the ZK re-key and relayed submission, not because they stay encrypted.
 */

import { timelockEncrypt, timelockDecrypt, roundAt, roundTime, Buffer } from "tlock-js"
import type { ChainClient, ChainInfo } from "tlock-js"

/** drand quicknet (RFC 9380 G1 signatures, 3 s rounds). Pinned here; never fetched. */
export const QUICKNET: ChainInfo = {
    public_key:
        "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
    period: 3,
    genesis_time: 1692803367,
    hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
    schemeID: "bls-unchained-g1-rfc9380",
    metadata: { beaconID: "quicknet" },
}

/** Public HTTP relays for quicknet beacons, tried in order. */
export const QUICKNET_ENDPOINTS = [
    "https://api.drand.sh",
    "https://api2.drand.sh",
    "https://api3.drand.sh",
    "https://drand.cloudflare.com",
]

export type Beacon = { round: number; randomness: string; signature: string }
export type BeaconFetcher = (round: number) => Promise<Beacon>

/** The first round published strictly after the voting deadline (unix seconds). */
export function sealRound(votingDeadline: number, chain: ChainInfo = QUICKNET): number {
    if (!Number.isFinite(votingDeadline) || votingDeadline <= 0) {
        throw new Error("This election has no voting deadline, so ballots can't be sealed.")
    }
    return roundAt(votingDeadline * 1000, chain) + 1
}

/** Unix seconds when the seal round is published and ballots can be opened. */
export function unsealTime(votingDeadline: number, chain: ChainInfo = QUICKNET): number {
    return Math.floor(roundTime(chain, sealRound(votingDeadline, chain)) / 1000)
}

function verifiedOptions(chain: ChainInfo) {
    return {
        disableBeaconVerification: false,
        noCache: false,
        chainVerificationParams: { chainHash: chain.hash, publicKey: chain.public_key },
    }
}

/** A drand client that only knows the pinned chain info. Encryption needs no network. */
function offlineClient(chain: ChainInfo): ChainClient {
    return {
        options: verifiedOptions(chain),
        chain: () => ({ baseUrl: "", info: async () => chain }),
        latest: async () => { throw new Error("Not available offline") },
        get: async () => { throw new Error("Not available offline") },
    }
}

/**
 * A client that serves exactly one beacon. Ciphertexts sealed to any other
 * round are rejected, so every counted ballot opens at the same moment.
 * tlock-js verifies the beacon's BLS signature against the pinned public key.
 */
function singleRoundClient(chain: ChainInfo, beacon: Beacon): ChainClient {
    return {
        options: verifiedOptions(chain),
        chain: () => ({ baseUrl: "", info: async () => chain }),
        latest: async () => beacon,
        get: async (round: number) => {
            if (round !== beacon.round) throw new Error(`Ballot sealed to round ${round}, expected ${beacon.round}`)
            return beacon
        },
    }
}

/** Fetch a quicknet beacon from the public endpoints, falling back on failure. */
export async function fetchQuicknetBeacon(round: number): Promise<Beacon> {
    let lastError: unknown = null
    for (const base of QUICKNET_ENDPOINTS) {
        try {
            const res = await fetch(`${base}/${QUICKNET.hash}/public/${round}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = await res.json()
            if (Number(body.round) !== round || typeof body.signature !== "string") throw new Error("Malformed beacon")
            return { round: Number(body.round), randomness: String(body.randomness), signature: body.signature }
        } catch (err) {
            lastError = err
        }
    }
    throw new Error(`Couldn't fetch drand round ${round}: ${lastError instanceof Error ? lastError.message : "unknown error"}`)
}

/** Encrypt a ballot payload so it opens only after the voting deadline. Returns UTF-8 bytes for the chain. */
export async function sealBallot(
    payload: Uint8Array,
    votingDeadline: number,
    chain: ChainInfo = QUICKNET,
): Promise<Uint8Array> {
    const round = sealRound(votingDeadline, chain)
    const armored = await timelockEncrypt(round, Buffer.from(payload), offlineClient(chain))
    return new TextEncoder().encode(armored)
}

export type OpenedBallot = { ok: true; payload: Uint8Array } | { ok: false; reason: string }

/**
 * Open every sealed ballot after the deadline. Anyone can call this; no key is needed.
 * Fetches the single seal-round beacon once, then decrypts locally.
 */
export async function openBallots(
    sealed: Uint8Array[],
    votingDeadline: number,
    options: { chain?: ChainInfo; fetchBeacon?: BeaconFetcher; now?: number } = {},
): Promise<OpenedBallot[]> {
    const chain = options.chain ?? QUICKNET
    const now = options.now ?? Date.now()
    const round = sealRound(votingDeadline, chain)
    const opensAt = roundTime(chain, round)
    if (opensAt > now) {
        throw new Error(`Ballots stay sealed until ${new Date(opensAt).toLocaleString()}.`)
    }
    const beacon = await (options.fetchBeacon ?? fetchQuicknetBeacon)(round)
    const client = singleRoundClient(chain, beacon)
    const decoder = new TextDecoder()
    const results: OpenedBallot[] = []
    for (const bytes of sealed) {
        try {
            const plaintext = await timelockDecrypt(decoder.decode(bytes), client)
            results.push({ ok: true, payload: new Uint8Array(plaintext) })
        } catch (err) {
            results.push({ ok: false, reason: err instanceof Error ? err.message : "Couldn't decrypt" })
        }
    }
    return results
}

/**
 * Ballot payload: vote (1 byte) || weight (1 byte) || randomness (32 bytes, big-endian).
 * The vote commitment Poseidon(vote, weight, randomness) is public on-chain, so the
 * opened payload can be checked against it.
 */
export function encodeVotePayload(vote: bigint, weight: bigint, randomness: bigint): Uint8Array {
    if (vote < 0n || vote > 255n) throw new Error("Vote out of range")
    if (weight < 1n || weight > 255n) throw new Error("Weight out of range")
    const buf = new Uint8Array(34)
    buf[0] = Number(vote)
    buf[1] = Number(weight)
    const rHex = randomness.toString(16).padStart(64, "0")
    if (rHex.length > 64) throw new Error("Randomness too large")
    for (let i = 0; i < 32; i++) buf[2 + i] = parseInt(rHex.substring(i * 2, i * 2 + 2), 16)
    return buf
}

export function decodeVotePayload(buf: Uint8Array): { vote: bigint; weight: bigint; voteRandomness: bigint } {
    if (buf.length !== 34) throw new Error("Malformed ballot payload")
    let rHex = ""
    for (let i = 0; i < 32; i++) rHex += buf[2 + i].toString(16).padStart(2, "0")
    return { vote: BigInt(buf[0]), weight: BigInt(buf[1]), voteRandomness: BigInt("0x" + rHex) }
}

export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex
    const out = new Uint8Array(clean.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
    return out
}
