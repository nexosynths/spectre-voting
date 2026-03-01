/**
 * Invite Codes — Utility Module
 *
 * Pure utility functions for generating, hashing, validating, and managing
 * one-time invite codes for the invite-code signup gate (v7.0).
 *
 * Code format: 8-char lowercase hex (4 random bytes). 2^32 possibilities.
 * For 250 codes, guessing probability is ~0.000006%.
 *
 * No React, no side effects.
 */

import { keccak256, toUtf8Bytes } from "ethers"

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/**
 * Generate N unique random 8-char lowercase hex codes.
 * Uses crypto.getRandomValues for secure randomness.
 */
export function generateCodes(count: number): string[] {
    const codes = new Set<string>()
    while (codes.size < count) {
        const bytes = new Uint8Array(4)
        crypto.getRandomValues(bytes)
        const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
        codes.add(hex)
    }
    return Array.from(codes)
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Hash a single invite code using keccak256.
 * Normalizes to lowercase + trimmed before hashing.
 */
export function hashCode(code: string): string {
    return keccak256(toUtf8Bytes(code.toLowerCase().trim()))
}

/**
 * Hash an array of codes. Returns parallel array of hashes.
 */
export function hashCodes(codes: string[]): string[] {
    return codes.map(c => hashCode(c))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a code against a list of code hashes.
 * @returns The matching hash if valid, or null if invalid.
 */
export function validateCode(code: string, codeHashes: string[]): string | null {
    const h = hashCode(code)
    return codeHashes.includes(h) ? h : null
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Convert codes to CSV content with optional per-code share links.
 */
export function codesToCsv(codes: string[], baseUrl?: string): string {
    const header = baseUrl ? "code,link" : "code"
    const rows = codes.map(c =>
        baseUrl ? `${c},${baseUrl}?code=${c}` : c
    )
    return [header, ...rows].join("\n")
}

/**
 * Trigger a browser file download.
 */
export function downloadCsv(csvContent: string, filename: string): void {
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const ADMIN_CODES_PREFIX = "spectre-invite-codes-"

/**
 * Store raw admin codes in localStorage for later retrieval.
 */
export function storeAdminCodes(electionAddress: string, codes: string[]): void {
    localStorage.setItem(`${ADMIN_CODES_PREFIX}${electionAddress}`, JSON.stringify(codes))
}

/**
 * Retrieve stored admin codes from localStorage.
 */
export function getAdminCodes(electionAddress: string): string[] | null {
    try {
        const raw = localStorage.getItem(`${ADMIN_CODES_PREFIX}${electionAddress}`)
        if (!raw) return null
        return JSON.parse(raw)
    } catch {
        return null
    }
}

// ---------------------------------------------------------------------------
// Allowlist functions (thin wrappers — same normalization + keccak256 as codes)
// ---------------------------------------------------------------------------

/**
 * Hash a single free-text identifier (email, name, student ID, etc.).
 * Reuses hashCode — same toLowerCase().trim() + keccak256 normalization.
 */
export function hashIdentifier(identifier: string): string {
    return hashCode(identifier)
}

/**
 * Hash an array of identifiers. Returns parallel array of hashes.
 */
export function hashIdentifiers(identifiers: string[]): string[] {
    return identifiers.map(hashIdentifier)
}

/**
 * Validate an identifier against allowlist hashes.
 * @returns The matching hash if valid, or null if invalid.
 */
export function validateIdentifier(identifier: string, allowlistHashes: string[]): string | null {
    return validateCode(identifier, allowlistHashes)
}

// ---------------------------------------------------------------------------
// Allowlist localStorage helpers
// ---------------------------------------------------------------------------

const ADMIN_ALLOWLIST_PREFIX = "spectre-allowlist-"

/**
 * Store raw admin allowlist identifiers in localStorage.
 */
export function storeAdminAllowlist(electionAddress: string, identifiers: string[]): void {
    localStorage.setItem(`${ADMIN_ALLOWLIST_PREFIX}${electionAddress}`, JSON.stringify(identifiers))
}

/**
 * Retrieve stored admin allowlist identifiers from localStorage.
 */
export function getAdminAllowlist(electionAddress: string): string[] | null {
    try {
        const raw = localStorage.getItem(`${ADMIN_ALLOWLIST_PREFIX}${electionAddress}`)
        if (!raw) return null
        return JSON.parse(raw)
    } catch {
        return null
    }
}

/**
 * Convert allowlist identifiers to CSV content with optional per-identifier share links.
 */
export function allowlistToCsv(identifiers: string[], baseUrl?: string): string {
    const header = baseUrl ? "identifier,link" : "identifier"
    const rows = identifiers.map(id =>
        baseUrl ? `${id},${baseUrl}?id=${encodeURIComponent(id)}` : id
    )
    return [header, ...rows].join("\n")
}
