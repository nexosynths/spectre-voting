"use client"

import { SpectreProvider } from "@/context/SpectreContext"
import { ModeProvider } from "@/context/ModeContext"

export default function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ModeProvider>
            <SpectreProvider>{children}</SpectreProvider>
        </ModeProvider>
    )
}
