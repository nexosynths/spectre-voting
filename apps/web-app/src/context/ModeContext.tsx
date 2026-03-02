"use client"

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react"

type Mode = "simple" | "advanced"

interface ModeContextType {
    mode: Mode
    setMode: (m: Mode) => void
    isSimple: boolean
    isAdvanced: boolean
}

const ModeContext = createContext<ModeContextType | null>(null)

const STORAGE_KEY = "spectre-mode"

export function ModeProvider({ children }: { children: ReactNode }) {
    const [mode, setModeState] = useState<Mode>("simple")

    // Read from localStorage on mount
    useEffect(() => {
        if (typeof window === "undefined") return
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored === "advanced") setModeState("advanced")
    }, [])

    const setMode = (m: Mode) => {
        setModeState(m)
        if (typeof window !== "undefined") {
            localStorage.setItem(STORAGE_KEY, m)
        }
    }

    return (
        <ModeContext.Provider value={{
            mode,
            setMode,
            isSimple: mode === "simple",
            isAdvanced: mode === "advanced",
        }}>
            {children}
        </ModeContext.Provider>
    )
}

export function useMode() {
    const ctx = useContext(ModeContext)
    if (!ctx) throw new Error("useMode must be used within ModeProvider")
    return ctx
}
