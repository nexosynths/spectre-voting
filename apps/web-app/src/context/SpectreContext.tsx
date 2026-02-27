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

    // Restore identity from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem("spectre-identity")
        if (saved) {
            try {
                setIdentity(Identity.import(saved))
            } catch {
                localStorage.removeItem("spectre-identity")
            }
        }
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
        const onAccounts = (accts: string[]) => {
            if (accts.length === 0) { setAddress(null); setSigner(null); setProvider(null) }
            else setAddress(accts[0])
        }
        const onChain = () => window.location.reload()
        window.ethereum.on?.("accountsChanged", onAccounts)
        window.ethereum.on?.("chainChanged", onChain)
        return () => {
            window.ethereum?.removeListener?.("accountsChanged", onAccounts)
            window.ethereum?.removeListener?.("chainChanged", onChain)
        }
    }, [])

    // Identity management
    const createIdentity = useCallback(() => {
        const id = new Identity()
        setIdentity(id)
        localStorage.setItem("spectre-identity", id.export())
        addLog("New Semaphore identity created")
    }, [addLog])

    const importIdentity = useCallback((key: string) => {
        try {
            const id = Identity.import(key)
            setIdentity(id)
            localStorage.setItem("spectre-identity", key)
            addLog("Identity imported successfully")
        } catch { addLog("Invalid key format") }
    }, [addLog])

    const clearIdentity = useCallback(() => {
        setIdentity(null)
        localStorage.removeItem("spectre-identity")
        addLog("Identity cleared")
    }, [addLog])

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
