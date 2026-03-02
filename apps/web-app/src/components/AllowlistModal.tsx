"use client"

import { allowlistToCsv, downloadCsv } from "@/lib/inviteCodes"

interface AllowlistModalProps {
    identifiers: string[]
    onClose: () => void
    copied: string
    onCopy: (text: string, label: string) => void
}

export default function AllowlistModal({ identifiers, onClose, copied, onCopy }: AllowlistModalProps) {
    if (identifiers.length === 0) return null

    return (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h4 style={{ fontSize: "0.9rem", fontWeight: 700 }}>Allowlist ({identifiers.length} entries)</h4>
                <button
                    onClick={onClose}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "1.1rem", cursor: "pointer", padding: "0 4px" }}
                >×</button>
            </div>
            <div style={{ padding: "8px 12px", background: "var(--success-bg)", borderRadius: "var(--radius)", border: "1px solid var(--success-border)", marginBottom: 12 }}>
                <p style={{ fontSize: "0.8rem", color: "var(--success)", fontWeight: 600 }}>
                    Allowlist saved. Share links with voters or let them enter their identifier manually.
                </p>
            </div>
            <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 12, padding: "8px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                {identifiers.map((id, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < identifiers.length - 1 ? "1px solid var(--border)" : "none" }}>
                        <span style={{ fontSize: "0.8rem" }}>{id}</span>
                        <button
                            onClick={() => onCopy(id, `allowlist-${i}`)}
                            style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}
                        >{copied === `allowlist-${i}` ? "Copied!" : "Copy"}</button>
                    </div>
                ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <button
                    className="btn-primary"
                    onClick={() => onCopy(identifiers.join("\n"), "all-allowlist")}
                    style={{ flex: 1, fontSize: "0.8rem" }}
                >{copied === "all-allowlist" ? "Copied!" : "Copy All"}</button>
                <button
                    className="btn-secondary"
                    onClick={() => {
                        const csv = allowlistToCsv(identifiers, typeof window !== "undefined" ? window.location.origin + "/election/" : undefined)
                        downloadCsv(csv, `allowlist-${new Date().toISOString().slice(0, 10)}.csv`)
                    }}
                    style={{ flex: 1, fontSize: "0.8rem" }}
                >Download CSV</button>
            </div>
        </div>
    )
}
