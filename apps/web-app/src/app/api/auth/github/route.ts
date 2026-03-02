/**
 * GitHub OAuth Initiation
 *
 * Redirects the voter to GitHub's OAuth authorize page.
 * The election address is encoded in a signed state parameter.
 */

import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"

export async function GET(request: NextRequest) {
    const clientId = process.env.GITHUB_CLIENT_ID
    const hmacSecret = process.env.GITHUB_HMAC_SECRET

    if (!clientId || !hmacSecret) {
        return NextResponse.json(
            { error: "GitHub authentication not configured" },
            { status: 503 }
        )
    }

    const election = request.nextUrl.searchParams.get("election")
    if (!election || !/^0x[0-9a-fA-F]{40}$/i.test(election)) {
        return NextResponse.json(
            { error: "Missing or invalid election address" },
            { status: 400 }
        )
    }

    // Build signed state: election:timestamp:hmac
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const mac = createHmac("sha256", hmacSecret)
        .update(election.toLowerCase() + timestamp)
        .digest("hex")
    const state = `${election.toLowerCase()}:${timestamp}:${mac}`

    // Construct callback URL from the current request origin
    const origin = request.nextUrl.origin
    const redirectUri = `${origin}/api/auth/github/callback`

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "read:org",
        state,
    })

    return NextResponse.redirect(
        `https://github.com/login/oauth/authorize?${params.toString()}`
    )
}
