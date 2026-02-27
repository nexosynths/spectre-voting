"use client"

import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react"
import { BrowserProvider, JsonRpcSigner } from "ethers"
import { Identity } from "@semaphore-protocol/core"
import { SEPOLIA_CHAIN_ID } from "@/lib/contracts"

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

    // Identity
    identity: Identity | null
    createIdentity: () => void
    importIdentity: (exportedKey: string) => void
    clearIdentity: () => void

    // Status
    logs: LogEntry[]
    addLog: (msg: string) => void
}

const SpectreContext = createContext<SpectreContextType | null>(null)

export function SpectreProvider({ children }: { children: ReactNode }) {
    const [address, setAddress] = useState<string | null>(null)
    const [signer, setSigner] = useState<JsonRpcSigner | null>(null)
    const [provider, setProvider] = useState<BrowserProvider | null>(null)
    const [identity, setIdentity] = useState<Identity | null>(null)
    const [logs, setLogs] = useState<LogEntry[]>([])

    const addLog = useCallback((msg: string) => {
        setLogs(prev => [{ msg, time: new Date() }, ...prev].slice(0, 100))
    }, [])

    // Identity storage key scoped to wallet address
    const identityKey = useCallback((addr: string) => `spectre-identity-${addr.toLowerCase()}`, [])

    // Load identity when wallet address changes
    useEffect(() => {
        if (!address) { setIdentity(null); return }
        const key = identityKey(address)
        const saved = localStorage.getItem(key)
        if (saved) {
            try {
                const id = Identity.import(saved)
                setIdentity(id)
                return
            } catch { localStorage.removeItem(key) }
        }

        // Backward compat: migrate global "spectre-identity" to this wallet's scoped key
        const global = localStorage.getItem("spectre-identity")
        if (global) {
            try {
                const id = Identity.import(global)
                setIdentity(id)
                localStorage.setItem(key, global)
                localStorage.removeItem("spectre-identity")
                return
            } catch { localStorage.removeItem("spectre-identity") }
        }

        setIdentity(null)
    }, [address, identityKey])

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

            if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
                addLog("Switching to Sepolia testnet...")
                await window.ethereum.request({
                    method: "wallet_switchEthereumChain",
                    params: [{ chainId: "0x" + SEPOLIA_CHAIN_ID.toString(16) }],
                })
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
            addLog(`Connection failed: ${err.message}`)
        }
    }, [addLog])

    // Listen for wallet events
    useEffect(() => {
        if (typeof window === "undefined" || !window.ethereum) return
        const onAccounts = async (accts: string[]) => {
            if (accts.length === 0) {
                setAddress(null); setSigner(null); setProvider(null)
            } else {
                // Update address, signer, and provider when wallet switches
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

    // Identity management — scoped to current wallet address
    const createIdentity = useCallback(() => {
        if (!address) { addLog("Connect wallet first"); return }
        const id = new Identity()
        setIdentity(id)
        localStorage.setItem(identityKey(address), id.export())
        addLog("New Semaphore identity created")
    }, [addLog, address, identityKey])

    const importIdentity = useCallback((key: string) => {
        if (!address) { addLog("Connect wallet first"); return }
        try {
            const id = Identity.import(key)
            setIdentity(id)
            localStorage.setItem(identityKey(address), key)
            addLog("Identity imported successfully")
        } catch { addLog("Invalid key format") }
    }, [addLog, address, identityKey])

    const clearIdentity = useCallback(() => {
        setIdentity(null)
        if (address) localStorage.removeItem(identityKey(address))
        addLog("Identity cleared")
    }, [addLog, address, identityKey])

    return (
        <SpectreContext.Provider value={{
            address, signer, provider, connectWallet,
            identity, createIdentity, importIdentity, clearIdentity,
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
