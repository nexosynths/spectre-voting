import { secp256k1 } from "@noble/curves/secp256k1"
import { randomBytes } from "@noble/ciphers/webcrypto"

// secp256k1 scalar field order (curve order n)
const ORDER = secp256k1.CURVE.n

/**
 * A single Shamir share: (x, y) where y = f(x) mod ORDER
 */
export interface Share {
    x: bigint // share index (1..n), never 0
    y: bigint // evaluated polynomial at x
}

function mod(a: bigint, m: bigint): bigint {
    return ((a % m) + m) % m
}

function modInverse(a: bigint, m: bigint): bigint {
    let [old_r, r] = [a, m]
    let [old_s, s] = [1n, 0n]
    while (r !== 0n) {
        const q = old_r / r
        ;[old_r, r] = [r, old_r - q * r]
        ;[old_s, s] = [s, old_s - q * s]
    }
    return mod(old_s, m)
}

/**
 * Generate a random bigint in [0, ORDER)
 */
function randomScalar(): bigint {
    const bytes = randomBytes(32)
    let val = 0n
    for (const b of bytes) val = (val << 8n) | BigInt(b)
    return mod(val, ORDER)
}

/**
 * Split a secret into n shares with threshold t (t-of-n reconstruction).
 *
 * @param secret — the value to split (must be in [0, ORDER))
 * @param n — total number of shares
 * @param t — minimum shares needed to reconstruct
 */
export function split(secret: bigint, n: number, t: number): Share[] {
    if (t < 2) throw new Error("Threshold must be at least 2")
    if (t > n) throw new Error("Threshold cannot exceed total shares")
    if (secret < 0n || secret >= ORDER) throw new Error("Secret must be in [0, ORDER)")

    // Random polynomial: f(x) = secret + a1*x + a2*x^2 + ... + a_{t-1}*x^{t-1}
    const coeffs = [secret]
    for (let i = 1; i < t; i++) {
        coeffs.push(randomScalar())
    }

    // Evaluate at x = 1, 2, ..., n
    const shares: Share[] = []
    for (let i = 1; i <= n; i++) {
        const x = BigInt(i)
        let y = 0n
        let xPow = 1n
        for (const coeff of coeffs) {
            y = mod(y + mod(coeff * xPow, ORDER), ORDER)
            xPow = mod(xPow * x, ORDER)
        }
        shares.push({ x, y })
    }

    return shares
}

/**
 * Reconstruct the secret from t or more shares using Lagrange interpolation at x=0.
 *
 * @param shares — at least t shares from split()
 */
export function combine(shares: Share[]): bigint {
    if (shares.length < 2) throw new Error("Need at least 2 shares")

    let secret = 0n

    for (let i = 0; i < shares.length; i++) {
        let num = 1n
        let den = 1n

        for (let j = 0; j < shares.length; j++) {
            if (i === j) continue
            // Lagrange basis: L_i(0) = ∏_{j≠i} (0 - x_j) / (x_i - x_j)
            num = mod(num * (0n - shares[j].x), ORDER)
            den = mod(den * (shares[i].x - shares[j].x), ORDER)
        }

        const lagrange = mod(num * modInverse(den, ORDER), ORDER)
        secret = mod(secret + mod(shares[i].y * lagrange, ORDER), ORDER)
    }

    return secret
}
