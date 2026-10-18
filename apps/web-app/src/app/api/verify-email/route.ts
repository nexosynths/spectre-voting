/**
 * Email Domain Verification API
 *
 * Two actions:
 * - "send": Sends a 6-digit verification code to the voter's email via Resend
 * - "verify": Validates the code and returns an HMAC token for relay signup
 *
 * The HMAC token is stateless — the relay can verify it without shared state.
 * Verification codes are stored in-memory with 5-minute TTL.
 */

import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import { createHmac, randomInt } from "crypto"
import { normalizeEmail, emailDomain } from "@/lib/gate"
import { cachedElectionMetadata } from "@/lib/server"

// ---------------------------------------------------------------------------
// In-memory code storage (resets on cold start — voter just re-sends).
// Keyed by the normalized address, so aliases of one inbox share one code and one limit.
// ---------------------------------------------------------------------------
interface StoredCode {
    code: string
    expires: number     // Unix ms
    attempts: number
    sendCount: number   // rate limit sends per email+election
    firstSentAt: number // rate limit window start
}

const verificationCodes = new Map<string, StoredCode>()

function codeKey(normalizedEmail: string, election: string): string {
    return `${normalizedEmail}|${election.toLowerCase()}`
}

function cleanExpired() {
    const now = Date.now()
    for (const [key, val] of verificationCodes) {
        if (val.expires < now) verificationCodes.delete(key)
    }
}

// ---------------------------------------------------------------------------
// HMAC token generation/verification
// ---------------------------------------------------------------------------
/** Token over the normalized address; the relay recomputes it before registering. */
function generateEmailToken(normalizedEmail: string, electionAddress: string): string {
    const secret = process.env.EMAIL_HMAC_SECRET
    if (!secret) throw new Error("EMAIL_HMAC_SECRET not configured")
    const payload = normalizedEmail + "|" + electionAddress.toLowerCase()
    return createHmac("sha256", secret).update(payload).digest("hex")
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { action } = body

        if (!action || !["send", "verify"].includes(action)) {
            return NextResponse.json(
                { success: false, error: "Invalid action" },
                { status: 400 }
            )
        }

        if (action === "send") return await handleSend(body)
        if (action === "verify") return await handleVerify(body)

        return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 })
    } catch (err: any) {
        console.error("verify-email error:", err)
        return NextResponse.json(
            { success: false, error: err.message || "Internal error" },
            { status: 500 }
        )
    }
}

// ---------------------------------------------------------------------------
// Send verification code
// ---------------------------------------------------------------------------
async function handleSend(body: any): Promise<NextResponse> {
    const { email, electionAddress } = body

    if (!email || !electionAddress) {
        return NextResponse.json(
            { success: false, error: "Missing email or electionAddress" },
            { status: 400 }
        )
    }

    // Validate email format. The code goes to the address as typed; limits and the
    // token use the normalized address, so +tag aliases of one inbox count once.
    const emailLower = String(email).toLowerCase().trim()
    const normalized = normalizeEmail(emailLower)
    if (!normalized) {
        return NextResponse.json(
            { success: false, error: "Invalid email format" },
            { status: 400 }
        )
    }

    // Check Resend is configured
    const resendKey = process.env.RESEND_API_KEY
    if (!resendKey) {
        return NextResponse.json(
            { success: false, error: "Email verification not configured" },
            { status: 503 }
        )
    }

    // Check HMAC secret is configured
    if (!process.env.EMAIL_HMAC_SECRET) {
        return NextResponse.json(
            { success: false, error: "Email verification not configured" },
            { status: 503 }
        )
    }

    // Fetch election metadata to validate domain
    if (typeof electionAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(electionAddress)) {
        return NextResponse.json({ success: false, error: "Invalid election address" }, { status: 400 })
    }
    const meta = await cachedElectionMetadata(electionAddress)

    if (!meta || meta.gateType !== "email-domain" || !meta.emailDomain?.domains) {
        return NextResponse.json(
            { success: false, error: "This election does not use email domain verification" },
            { status: 400 }
        )
    }

    // Extract domain from email and check against allowed domains
    const domain = emailDomain(emailLower)
    const allowedDomains: string[] = meta.emailDomain.domains.map((d: string) => d.toLowerCase().trim())

    if (!allowedDomains.includes(domain)) {
        return NextResponse.json(
            { success: false, error: `Domain @${domain} is not allowed. Accepted: ${allowedDomains.map(d => "@" + d).join(", ")}` },
            { status: 400 }
        )
    }

    // Rate limit: 3 sends per inbox per hour
    cleanExpired()
    const key = codeKey(normalized, electionAddress)
    const existing = verificationCodes.get(key)

    if (existing) {
        const oneHourAgo = Date.now() - 60 * 60 * 1000
        if (existing.firstSentAt > oneHourAgo && existing.sendCount >= 3) {
            return NextResponse.json(
                { success: false, error: "Too many code requests. Try again in an hour." },
                { status: 429 }
            )
        }
    }

    // Generate 6-digit code
    const code = String(randomInt(100000, 999999))

    // Store code
    verificationCodes.set(key, {
        code,
        expires: Date.now() + 5 * 60 * 1000, // 5 minutes
        attempts: 0,
        sendCount: (existing && existing.firstSentAt > Date.now() - 60 * 60 * 1000) ? existing.sendCount + 1 : 1,
        firstSentAt: (existing && existing.firstSentAt > Date.now() - 60 * 60 * 1000) ? existing.firstSentAt : Date.now(),
    })

    // Send email via Resend
    const resend = new Resend(resendKey)
    const fromEmail = process.env.RESEND_FROM_EMAIL || "noreply@spectre-voting.app"

    try {
        await resend.emails.send({
            from: `Spectre Voting <${fromEmail}>`,
            to: emailLower,
            subject: "Your Spectre verification code",
            text: `Your verification code is: ${code}\n\nThis code expires in 5 minutes.\n\n— Spectre Voting`,
            html: `<div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
<p style="font-size: 16px;">Your verification code is:</p>
<p style="font-size: 32px; font-weight: bold; letter-spacing: 0.15em; text-align: center; padding: 16px 0; background: #f5f5f5; border-radius: 8px;">${code}</p>
<p style="font-size: 14px; color: #666;">This code expires in 5 minutes.</p>
<p style="font-size: 14px; color: #999;">&mdash; Spectre Voting</p>
</div>`,
        })
    } catch (err: any) {
        console.error("Resend error:", err)
        // Delete the stored code since email failed
        verificationCodes.delete(key)
        return NextResponse.json(
            { success: false, error: "Failed to send verification email" },
            { status: 500 }
        )
    }

    return NextResponse.json({ success: true })
}

// ---------------------------------------------------------------------------
// Verify code and return HMAC token
// ---------------------------------------------------------------------------
async function handleVerify(body: any): Promise<NextResponse> {
    const { email, code, electionAddress } = body

    if (!email || !code || !electionAddress) {
        return NextResponse.json(
            { success: false, error: "Missing email, code, or electionAddress" },
            { status: 400 }
        )
    }

    const normalized = normalizeEmail(String(email))
    if (!normalized || typeof electionAddress !== "string") {
        return NextResponse.json({ success: false, error: "Invalid email or election" }, { status: 400 })
    }
    const key = codeKey(normalized, electionAddress)

    cleanExpired()
    const stored = verificationCodes.get(key)

    if (!stored) {
        return NextResponse.json(
            { success: false, error: "No code found. Request a new one." },
            { status: 400 }
        )
    }

    if (stored.expires < Date.now()) {
        verificationCodes.delete(key)
        return NextResponse.json(
            { success: false, error: "Code expired. Request a new one." },
            { status: 400 }
        )
    }

    // Max 5 attempts per code
    if (stored.attempts >= 5) {
        verificationCodes.delete(key)
        return NextResponse.json(
            { success: false, error: "Too many attempts. Request a new code." },
            { status: 400 }
        )
    }

    stored.attempts++

    if (stored.code !== String(code).trim()) {
        return NextResponse.json(
            { success: false, error: "Incorrect code" },
            { status: 400 }
        )
    }

    // Code matches — delete it (single-use) and return HMAC token
    verificationCodes.delete(key)

    const token = generateEmailToken(normalized, electionAddress)

    return NextResponse.json({ success: true, token })
}
