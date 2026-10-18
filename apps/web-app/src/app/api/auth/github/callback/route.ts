/**
 * GitHub OAuth Callback
 *
 * Handles the redirect from GitHub after the user authorizes.
 * Exchanges the code for an access token, checks org membership,
 * generates an HMAC token, and redirects back to the election page.
 */

import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"
import { cachedElectionMetadata } from "@/lib/server"

// ---------------------------------------------------------------------------
// Main callback handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
    const code = request.nextUrl.searchParams.get("code")
    const state = request.nextUrl.searchParams.get("state")
    const error = request.nextUrl.searchParams.get("error")

    // GitHub sends error param if user denies OAuth
    if (error) {
        // Can't redirect without election address — show error
        return NextResponse.json(
            { error: `GitHub OAuth denied: ${error}` },
            { status: 400 }
        )
    }

    if (!code || !state) {
        return NextResponse.json(
            { error: "Missing code or state" },
            { status: 400 }
        )
    }

    const hmacSecret = process.env.GITHUB_HMAC_SECRET
    const clientId = process.env.GITHUB_CLIENT_ID
    const clientSecret = process.env.GITHUB_CLIENT_SECRET

    if (!hmacSecret || !clientId || !clientSecret) {
        return NextResponse.json(
            { error: "GitHub authentication not configured" },
            { status: 503 }
        )
    }

    // ---------------------------------------------------------------------------
    // 1. Verify state
    // ---------------------------------------------------------------------------
    const parts = state.split(":")
    if (parts.length !== 3) {
        return NextResponse.json({ error: "Invalid state" }, { status: 400 })
    }

    const [electionAddress, timestamp, mac] = parts
    const expectedMac = createHmac("sha256", hmacSecret)
        .update(electionAddress + timestamp)
        .digest("hex")

    if (mac !== expectedMac) {
        return NextResponse.json({ error: "Invalid state signature" }, { status: 400 })
    }

    // Check state freshness (10 min)
    const stateAge = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10)
    if (stateAge > 600 || stateAge < 0) {
        return redirectWithError(request, electionAddress, "OAuth session expired. Please try again.")
    }

    // ---------------------------------------------------------------------------
    // 2. Exchange code for access token
    // ---------------------------------------------------------------------------
    let accessToken: string
    try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code,
            }),
        })
        const tokenData = await tokenRes.json()
        if (tokenData.error || !tokenData.access_token) {
            return redirectWithError(request, electionAddress, tokenData.error_description || "Failed to get access token")
        }
        accessToken = tokenData.access_token
    } catch {
        return redirectWithError(request, electionAddress, "Failed to exchange code with GitHub")
    }

    // ---------------------------------------------------------------------------
    // 3. Fetch GitHub user profile
    // ---------------------------------------------------------------------------
    let githubId: string
    let githubLogin: string
    try {
        const userRes = await fetch("https://api.github.com/user", {
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/vnd.github+json",
            },
        })
        if (!userRes.ok) {
            return redirectWithError(request, electionAddress, "Failed to fetch GitHub profile")
        }
        const userData = await userRes.json()
        githubId = String(userData.id)
        githubLogin = userData.login
    } catch {
        return redirectWithError(request, electionAddress, "Failed to fetch GitHub profile")
    }

    // ---------------------------------------------------------------------------
    // 4. Fetch election metadata to get org name
    // ---------------------------------------------------------------------------
    const meta = await cachedElectionMetadata(electionAddress)

    if (!meta || meta.gateType !== "github-org" || !meta.githubOrg?.org) {
        return redirectWithError(request, electionAddress, "This election does not use GitHub org verification")
    }

    const requiredOrg = meta.githubOrg.org

    // ---------------------------------------------------------------------------
    // 5. Check org membership
    // ---------------------------------------------------------------------------
    try {
        const memberRes = await fetch(
            `https://api.github.com/user/memberships/orgs/${encodeURIComponent(requiredOrg)}`,
            {
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Accept": "application/vnd.github+json",
                },
            }
        )

        if (memberRes.status === 404) {
            return redirectWithError(request, electionAddress, `You are not a member of github.com/${requiredOrg}`)
        }

        if (!memberRes.ok) {
            return redirectWithError(request, electionAddress, "Failed to check org membership")
        }

        const memberData = await memberRes.json()
        if (memberData.state !== "active") {
            return redirectWithError(request, electionAddress, `Your membership in ${requiredOrg} is pending. Ask an org admin to confirm.`)
        }
    } catch {
        return redirectWithError(request, electionAddress, "Failed to check org membership")
    }

    // ---------------------------------------------------------------------------
    // 6. Generate HMAC token and redirect back
    // ---------------------------------------------------------------------------
    const ghToken = createHmac("sha256", hmacSecret)
        .update(githubId + "|" + electionAddress.toLowerCase())
        .digest("hex")

    const origin = request.nextUrl.origin
    const params = new URLSearchParams({
        ghToken,
        ghUser: githubLogin,
        ghId: githubId,
    })

    return NextResponse.redirect(
        `${origin}/election/${electionAddress}?${params.toString()}`
    )
}

// ---------------------------------------------------------------------------
// Helper: redirect back to election page with error
// ---------------------------------------------------------------------------
function redirectWithError(request: NextRequest, electionAddress: string, error: string): NextResponse {
    const origin = request.nextUrl.origin
    const params = new URLSearchParams({ ghError: error })
    return NextResponse.redirect(
        `${origin}/election/${electionAddress}?${params.toString()}`
    )
}
