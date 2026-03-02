"use client"

interface TrustCalloutProps {
    text: string
    variant?: "info" | "caution" | "warning"
}

export default function TrustCallout({ text, variant = "info" }: TrustCalloutProps) {
    if (!text) return null
    return (
        <div className={`trust-callout trust-callout-${variant}`}>
            {text}
        </div>
    )
}
