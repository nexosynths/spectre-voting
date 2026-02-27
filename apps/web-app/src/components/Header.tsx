"use client"

import Link from "next/link"
import { useSpectre } from "@/context/SpectreContext"

export default function Header() {
    const { address, connectWallet, identity } = useSpectre()

    return (
        <header className="header">
            <Link href="/" style={{ textDecoration: "none", color: "var(--text)" }}>
                <h1>Spectre</h1>
            </Link>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {identity && (
                    <span style={{ fontSize: "0.7rem", color: "var(--success)", background: "#22c55e18", padding: "4px 10px", borderRadius: 20 }}>
                        ID Active
                    </span>
                )}
                {address ? (
                    <span className="mono" style={{ color: "var(--accent)", fontSize: "0.8rem" }}>
                        {address.slice(0, 6)}...{address.slice(-4)}
                    </span>
                ) : (
                    <button className="btn-secondary" onClick={connectWallet} style={{ width: "auto", padding: "8px 16px", fontSize: "0.8rem" }}>
                        Connect
                    </button>
                )}
            </div>
        </header>
    )
}
