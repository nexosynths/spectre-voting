"use client"

import { useMode } from "@/context/ModeContext"

export default function ModeToggle() {
    const { mode, setMode } = useMode()

    return (
        <div className="mode-toggle">
            <button
                className={mode === "simple" ? "mode-toggle-btn active" : "mode-toggle-btn"}
                onClick={() => setMode("simple")}
            >
                Simple
            </button>
            <button
                className={mode === "advanced" ? "mode-toggle-btn active" : "mode-toggle-btn"}
                onClick={() => setMode("advanced")}
            >
                Advanced
            </button>
        </div>
    )
}
