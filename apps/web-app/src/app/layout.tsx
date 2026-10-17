import type { Metadata } from "next"
import "./globals.css"
import Providers from "@/components/Providers"
import Header from "@/components/Header"

export const metadata: Metadata = {
    title: "Spectre — Anonymous Voting",
    description: "ZK-powered anonymous encrypted voting for DAOs"
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1" />
            </head>
            <body suppressHydrationWarning>
                <div className="prototype-banner" role="note">
                    Research prototype: unaudited, with known privacy limitations. Don&apos;t use it for votes that matter.
                </div>
                <Providers>
                    <Header />
                    <main className="container">
                        {children}
                    </main>
                </Providers>
            </body>
        </html>
    )
}
