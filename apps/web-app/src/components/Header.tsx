"use client"

import Link from "next/link"
import { useSpectre } from "@/context/SpectreContext"

export default function Header() {
    const { address, connectWallet } = useSpectre()

    return (
        <header className="header">
            <Link href="/" style={{ textDecoration: "none", color: "var(--text)" }}>
                <h1>Spectre</h1>
            </Link>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                {address ? (
                    <span className="mono" style={{ color: "var(--accent)", fontSize: "0.8rem" }}>
                        {address.slice(0, 6)}...{address.slice(-4)}
                    </span>
                ) : (
                    <button className="btn-secondary" onClick={connectWallet} style={{ width: "auto", padding: "8px 16px", fontSize: "0.8rem" }}>
                        Connect Wallet
                    </button>
                )}
            </div>
        </header>
    )
}
