"use client"

import { SpectreProvider } from "@/context/SpectreContext"

export default function Providers({ children }: { children: React.ReactNode }) {
    return <SpectreProvider>{children}</SpectreProvider>
}
