/**
 * Server-side helpers shared by the API routes (relay, email verification, GitHub).
 * Not for the browser: reads server environment variables.
 */

import { JsonRpcProvider } from "ethers"
import { RPC_URL } from "@/lib/contracts"
import { fetchElectionMetadata } from "@/lib/chain"

let provider: JsonRpcProvider | null = null

/**
 * The RPC the server uses. Set RELAY_RPC_URL to a dedicated (ideally archive) Base
 * endpoint; token-gated elections need historical balances at their snapshot block.
 */
export function serverProvider(): JsonRpcProvider {
    if (!provider) provider = new JsonRpcProvider(process.env.RELAY_RPC_URL || RPC_URL)
    return provider
}

const metadataCache = new Map<string, Record<string, any>>()

/** Election metadata from the factory event, cached per server instance (it never changes). */
export async function cachedElectionMetadata(electionAddress: string): Promise<Record<string, any> | null> {
    const key = electionAddress.toLowerCase()
    const cached = metadataCache.get(key)
    if (cached) return cached
    const meta = await fetchElectionMetadata(electionAddress, serverProvider())
    if (meta) metadataCache.set(key, meta)
    return meta
}

/** The first address in X-Forwarded-For (the client), or X-Real-IP. */
export function clientIp(headers: Headers): string {
    const forwarded = headers.get("x-forwarded-for")
    if (forwarded) return forwarded.split(",")[0].trim() || "unknown"
    return headers.get("x-real-ip") || "unknown"
}
