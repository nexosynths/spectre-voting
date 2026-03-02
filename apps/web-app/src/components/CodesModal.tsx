"use client"

import { codesToCsv, downloadCsv } from "@/lib/inviteCodes"

interface CodesModalProps {
    codes: string[]
    onClose: () => void
    copied: string
    onCopy: (text: string, label: string) => void
}

export default function CodesModal({ codes, onClose, copied, onCopy }: CodesModalProps) {
    if (codes.length === 0) return null

    return (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h4 style={{ fontSize: "0.9rem", fontWeight: 700 }}>Invite Codes ({codes.length})</h4>
                <button
                    onClick={onClose}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "1.1rem", cursor: "pointer", padding: "0 4px" }}
                >×</button>
            </div>
            <div style={{ padding: "8px 12px", background: "var(--error-bg)", borderRadius: "var(--radius)", border: "1px solid var(--error-border)", marginBottom: 12 }}>
                <p style={{ fontSize: "0.8rem", color: "var(--error)", fontWeight: 600 }}>
                    Save these codes now — they cannot be recovered later
                </p>
            </div>
            <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 12, padding: "8px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                {codes.map((code, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: i < codes.length - 1 ? "1px solid var(--border)" : "none" }}>
                        <code className="mono" style={{ fontSize: "0.8rem" }}>{code}</code>
                        <button
                            onClick={() => onCopy(code, `code-${i}`)}
                            style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.7rem", cursor: "pointer" }}
                        >{copied === `code-${i}` ? "Copied!" : "Copy"}</button>
                    </div>
                ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <button
                    className="btn-primary"
                    onClick={() => onCopy(codes.join("\n"), "all-codes")}
                    style={{ flex: 1, fontSize: "0.8rem" }}
                >{copied === "all-codes" ? "Copied!" : "Copy All"}</button>
                <button
                    className="btn-secondary"
                    onClick={() => {
                        const csv = codesToCsv(codes, typeof window !== "undefined" ? window.location.origin + "/election/" : undefined)
                        downloadCsv(csv, `invite-codes-${new Date().toISOString().slice(0, 10)}.csv`)
                    }}
                    style={{ flex: 1, fontSize: "0.8rem" }}
                >Download CSV</button>
            </div>
        </div>
    )
}
