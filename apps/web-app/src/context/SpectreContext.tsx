"use client"

import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react"
import { BrowserProvider, JsonRpcSigner } from "ethers"
import { CHAIN_ID } from "@/lib/contracts"

declare global {
    interface Window {
        ethereum?: any
    }
}

export interface LogEntry {
    msg: string
    time: Date
}

export interface SpectreContextType {
    // Wallet
    address: string | null
    signer: JsonRpcSigner | null
    provider: BrowserProvider | null
    connectWallet: () => Promise<void>

    // Anonymous ID (for gasless/walletless voting)
    anonymousId: string | null

    // Status
    logs: LogEntry[]
    addLog: (msg: string) => void
}

const SpectreContext = createContext<SpectreContextType | null>(null)

/** Get or create a stable anonymous ID for walletless voters */
function getOrCreateAnonymousId(): string {
    if (typeof window === "undefined") return ""
    const key = "spectre-anonymous-id"
    let id = localStorage.getItem(key)
    if (!id) {
        id = crypto.randomUUID()
        localStorage.setItem(key, id)
    }
    return id
}

export function SpectreProvider({ children }: { children: ReactNode }) {
    const [address, setAddress] = useState<string | null>(null)
    const [signer, setSigner] = useState<JsonRpcSigner | null>(null)
    const [provider, setProvider] = useState<BrowserProvider | null>(null)
    const [anonymousId, setAnonymousId] = useState<string | null>(null)
    const [logs, setLogs] = useState<LogEntry[]>([])

    const addLog = useCallback((msg: string) => {
        setLogs(prev => [{ msg, time: new Date() }, ...prev].slice(0, 100))
    }, [])

    // Initialize anonymous ID on mount
    useEffect(() => {
        setAnonymousId(getOrCreateAnonymousId())
    }, [])

    // Wallet connection
    const connectWallet = useCallback(async () => {
        if (typeof window === "undefined" || !window.ethereum) {
            addLog("No wallet detected — install MetaMask or Rabby")
            return
        }
        try {
            const bp = new BrowserProvider(window.ethereum)
            const accounts: string[] = await bp.send("eth_requestAccounts", [])
            const network = await bp.getNetwork()

            if (Number(network.chainId) !== CHAIN_ID) {
                addLog("Switching to Base...")
                try {
                    await window.ethereum.request({
                        method: "wallet_switchEthereumChain",
                        params: [{ chainId: "0x" + CHAIN_ID.toString(16) }],
                    })
                } catch (switchError: any) {
                    if (switchError.code === 4902) {
                        await window.ethereum.request({
                            method: "wallet_addEthereumChain",
                            params: [{
                                chainId: "0x" + CHAIN_ID.toString(16),
                                chainName: "Base",
                                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                                rpcUrls: ["https://mainnet.base.org"],
                                blockExplorerUrls: ["https://basescan.org"],
                            }],
                        })
                    } else {
                        throw switchError
                    }
                }
                const bp2 = new BrowserProvider(window.ethereum)
                setProvider(bp2)
                setSigner(await bp2.getSigner())
                setAddress(accounts[0])
                addLog(`Connected: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`)
                return
            }

            setProvider(bp)
            setSigner(await bp.getSigner())
            setAddress(accounts[0])
            addLog(`Connected: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`)
        } catch (err: any) {
            addLog("Wallet connection failed. Make sure your wallet is unlocked and try again.")
        }
    }, [addLog])

    // Auto-connect on page load if wallet was previously authorized
    useEffect(() => {
        if (typeof window === "undefined" || !window.ethereum) return
        const bp = new BrowserProvider(window.ethereum)
        bp.send("eth_accounts", []).then(async (accounts: string[]) => {
            if (accounts.length > 0) {
                try {
                    const network = await bp.getNetwork()
                    if (Number(network.chainId) === CHAIN_ID) {
                        setProvider(bp)
                        setSigner(await bp.getSigner())
                        setAddress(accounts[0])
                    }
                } catch { /* silently fail */ }
            }
        }).catch(() => {})
    }, [])

    // Listen for wallet events (account switch, chain switch)
    useEffect(() => {
        if (typeof window === "undefined" || !window.ethereum) return
        const onAccounts = async (accts: string[]) => {
            if (accts.length === 0) {
                setAddress(null); setSigner(null); setProvider(null)
            } else {
                try {
                    const bp = new BrowserProvider(window.ethereum)
                    setProvider(bp)
                    setSigner(await bp.getSigner())
                    setAddress(accts[0])
                    addLog(`Switched to: ${accts[0].slice(0, 6)}...${accts[0].slice(-4)}`)
                } catch {
                    setAddress(accts[0])
                }
            }
        }
        const onChain = () => window.location.reload()
        window.ethereum.on?.("accountsChanged", onAccounts)
        window.ethereum.on?.("chainChanged", onChain)
        return () => {
            window.ethereum?.removeListener?.("accountsChanged", onAccounts)
            window.ethereum?.removeListener?.("chainChanged", onChain)
        }
    }, [addLog])

    return (
        <SpectreContext.Provider value={{
            address, signer, provider, connectWallet,
            anonymousId,
            logs, addLog,
        }}>
            {children}
        </SpectreContext.Provider>
    )
}

export function useSpectre() {
    const ctx = useContext(SpectreContext)
    if (!ctx) throw new Error("useSpectre must be used within SpectreProvider")
    return ctx
}
