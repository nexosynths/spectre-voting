"use client"

import { useReducer, useEffect, useMemo } from "react"
import { Contract, JsonRpcProvider, isAddress } from "ethers"
import { RPC_URL } from "@/lib/contracts"

// ─── Types ───────────────────────────────────────────────────────

export type GateType = "open" | "invite-codes" | "allowlist" | "admin-only" | "token-gate" | "email-domain" | "github-org"

export interface CommitteeMember {
    name: string
    address: string
}

export interface ElectionFormState {
    // Wizard
    currentStep: number // 0-3
    creating: boolean

    // Step 1: Basics
    electionTitle: string
    optionLabels: string[]
    signupHours: string
    votingHours: string

    // Step 2: Access
    gateType: GateType
    codeCount: string
    allowlistInput: string
    tokenAddress: string
    tokenType: "erc20" | "erc721"
    tokenMinBalance: string
    tokenSymbol: string
    tokenDecimals: number
    weightedVoting: boolean
    voteThreshold: string
    emailDomains: string
    githubOrg: string
    gaslessMode: boolean

    // Step 3: Security
    encryptionMode: "single" | "threshold"
    committeeMembers: CommitteeMember[]
    threshold: number

    // Post-creation (modals)
    generatedCodes: string[]
    showCodesModal: boolean
    allowlistIdentifiers: string[]
    showAllowlistModal: boolean
}

// ─── Actions ─────────────────────────────────────────────────────

type Action =
    | { type: "SET_FIELD"; field: keyof ElectionFormState; value: any }
    | { type: "SET_GATE_TYPE"; gateType: GateType }
    | { type: "SET_ENCRYPTION_MODE"; mode: "single" | "threshold" }
    | { type: "ADD_OPTION" }
    | { type: "REMOVE_OPTION"; index: number }
    | { type: "UPDATE_OPTION"; index: number; value: string }
    | { type: "ADD_COMMITTEE_MEMBER" }
    | { type: "REMOVE_COMMITTEE_MEMBER"; index: number }
    | { type: "UPDATE_COMMITTEE_MEMBER"; index: number; field: "name" | "address"; value: string }
    | { type: "SET_TOKEN_INFO"; symbol: string; decimals: number }
    | { type: "NEXT_STEP" }
    | { type: "PREV_STEP" }
    | { type: "GO_TO_STEP"; step: number }
    | { type: "SET_CREATING"; creating: boolean }
    | { type: "POST_CREATE"; codes?: string[]; identifiers?: string[] }
    | { type: "CLOSE_MODAL"; modal: "codes" | "allowlist" }
    | { type: "RESET" }

// ─── Initial state ───────────────────────────────────────────────

const initialState: ElectionFormState = {
    currentStep: 0,
    creating: false,
    electionTitle: "",
    optionLabels: ["Yes", "No"],
    signupHours: "24",
    votingHours: "72",
    gateType: "open",
    codeCount: "20",
    allowlistInput: "",
    tokenAddress: "",
    tokenType: "erc20",
    tokenMinBalance: "1",
    tokenSymbol: "",
    tokenDecimals: 18,
    weightedVoting: false,
    voteThreshold: "",
    emailDomains: "",
    githubOrg: "",
    gaslessMode: false,
    encryptionMode: "single",
    committeeMembers: [
        { name: "", address: "" },
        { name: "", address: "" },
        { name: "", address: "" },
    ],
    threshold: 2,
    generatedCodes: [],
    showCodesModal: false,
    allowlistIdentifiers: [],
    showAllowlistModal: false,
}

// ─── Reducer ─────────────────────────────────────────────────────

function reducer(state: ElectionFormState, action: Action): ElectionFormState {
    switch (action.type) {
        case "SET_FIELD":
            return { ...state, [action.field]: action.value }

        case "SET_GATE_TYPE":
            return {
                ...state,
                gateType: action.gateType,
                // Reset gate-specific fields when switching
                codeCount: action.gateType === "invite-codes" ? state.codeCount : "20",
                allowlistInput: action.gateType === "allowlist" ? state.allowlistInput : "",
                tokenAddress: action.gateType === "token-gate" ? state.tokenAddress : "",
                tokenType: action.gateType === "token-gate" ? state.tokenType : "erc20",
                tokenMinBalance: action.gateType === "token-gate" ? state.tokenMinBalance : "1",
                tokenSymbol: action.gateType === "token-gate" ? state.tokenSymbol : "",
                tokenDecimals: action.gateType === "token-gate" ? state.tokenDecimals : 18,
                weightedVoting: action.gateType === "token-gate" ? state.weightedVoting : false,
                voteThreshold: action.gateType === "token-gate" ? state.voteThreshold : "",
                emailDomains: action.gateType === "email-domain" ? state.emailDomains : "",
                githubOrg: action.gateType === "github-org" ? state.githubOrg : "",
            }

        case "SET_ENCRYPTION_MODE":
            return {
                ...state,
                encryptionMode: action.mode,
                committeeMembers: action.mode === "threshold" ? state.committeeMembers : [
                    { name: "", address: "" },
                    { name: "", address: "" },
                    { name: "", address: "" },
                ],
                threshold: action.mode === "threshold" ? state.threshold : 2,
            }

        case "ADD_OPTION":
            if (state.optionLabels.length >= 10) return state
            return { ...state, optionLabels: [...state.optionLabels, ""] }

        case "REMOVE_OPTION":
            if (state.optionLabels.length <= 2) return state
            return { ...state, optionLabels: state.optionLabels.filter((_, i) => i !== action.index) }

        case "UPDATE_OPTION": {
            const labels = [...state.optionLabels]
            labels[action.index] = action.value
            return { ...state, optionLabels: labels }
        }

        case "ADD_COMMITTEE_MEMBER":
            if (state.committeeMembers.length >= 10) return state
            return { ...state, committeeMembers: [...state.committeeMembers, { name: "", address: "" }] }

        case "REMOVE_COMMITTEE_MEMBER": {
            if (state.committeeMembers.length <= 2) return state
            const next = state.committeeMembers.filter((_, i) => i !== action.index)
            return {
                ...state,
                committeeMembers: next,
                threshold: state.threshold > next.length ? next.length : state.threshold,
            }
        }

        case "UPDATE_COMMITTEE_MEMBER": {
            const members = [...state.committeeMembers]
            members[action.index] = { ...members[action.index], [action.field]: action.value }
            return { ...state, committeeMembers: members }
        }

        case "SET_TOKEN_INFO":
            return { ...state, tokenSymbol: action.symbol, tokenDecimals: action.decimals }

        case "NEXT_STEP":
            return { ...state, currentStep: Math.min(state.currentStep + 1, 3) }

        case "PREV_STEP":
            return { ...state, currentStep: Math.max(state.currentStep - 1, 0) }

        case "GO_TO_STEP":
            return { ...state, currentStep: Math.max(0, Math.min(3, action.step)) }

        case "SET_CREATING":
            return { ...state, creating: action.creating }

        case "POST_CREATE":
            return {
                ...state,
                generatedCodes: action.codes || [],
                showCodesModal: (action.codes?.length || 0) > 0,
                allowlistIdentifiers: action.identifiers || [],
                showAllowlistModal: (action.identifiers?.length || 0) > 0,
            }

        case "CLOSE_MODAL":
            if (action.modal === "codes") return { ...state, showCodesModal: false }
            return { ...state, showAllowlistModal: false }

        case "RESET":
            return { ...initialState }

        default:
            return state
    }
}

// ─── Hook ────────────────────────────────────────────────────────

export function useElectionForm() {
    const [state, dispatch] = useReducer(reducer, initialState)

    // Derived values
    const selfSignup = state.gateType !== "admin-only"

    const walletForced = state.gateType === "token-gate"
    const gaslessForced = ["invite-codes", "allowlist", "email-domain", "github-org"].includes(state.gateType)
    const effectiveGasless = walletForced ? false : gaslessForced ? true : state.gaslessMode
    const gaslessLocked = walletForced || gaslessForced

    const validCommitteeMembers = useMemo(
        () => state.committeeMembers.filter(m => m.name.trim() && isAddress(m.address.trim())),
        [state.committeeMembers],
    )

    // Per-step validation
    const canProceedFromStep = useMemo(() => {
        const step0 = state.electionTitle.trim().length > 0 && state.optionLabels.filter(l => l.trim()).length >= 2
        const step1 = (() => {
            switch (state.gateType) {
                case "token-gate":
                    return /^0x[0-9a-fA-F]{40}$/.test(state.tokenAddress)
                case "allowlist": {
                    const entries = state.allowlistInput.split("\n").map(s => s.trim()).filter(Boolean)
                    return new Set(entries).size >= 2
                }
                case "invite-codes":
                    return Number(state.codeCount) >= 2 && Number(state.codeCount) <= 250
                case "email-domain":
                    return state.emailDomains.split(",").map(d => d.trim()).filter(Boolean).length > 0
                case "github-org":
                    return state.githubOrg.trim().length > 0
                default:
                    return true
            }
        })()
        const step2 = state.encryptionMode === "single" || validCommitteeMembers.length >= 2
        return [step0, step1, step2, true] // step 3 (review) always valid
    }, [state.electionTitle, state.optionLabels, state.gateType, state.tokenAddress, state.allowlistInput, state.codeCount, state.emailDomains, state.githubOrg, state.encryptionMode, validCommitteeMembers])

    const canCreate = canProceedFromStep.every(Boolean) && !state.creating

    // Token symbol/decimals auto-fetch
    useEffect(() => {
        if (state.gateType !== "token-gate" || !/^0x[0-9a-fA-F]{40}$/.test(state.tokenAddress)) {
            dispatch({ type: "SET_TOKEN_INFO", symbol: "", decimals: 0 })
            return
        }
        let cancelled = false
        ;(async () => {
            try {
                const provider = new JsonRpcProvider(RPC_URL)
                const abi = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"]
                const c = new Contract(state.tokenAddress, abi, provider)
                const [sym, dec] = await Promise.all([c.symbol().catch(() => ""), c.decimals().catch(() => 0)])
                if (!cancelled) {
                    dispatch({ type: "SET_TOKEN_INFO", symbol: sym || "", decimals: Number(dec) || 0 })
                }
            } catch {
                if (!cancelled) dispatch({ type: "SET_TOKEN_INFO", symbol: "", decimals: 0 })
            }
        })()
        return () => { cancelled = true }
    }, [state.tokenAddress, state.gateType])

    return {
        state,
        dispatch,
        // Derived
        selfSignup,
        effectiveGasless,
        gaslessLocked,
        walletForced,
        gaslessForced,
        validCommitteeMembers,
        canProceedFromStep,
        canCreate,
    }
}

export type ElectionFormDispatch = ReturnType<typeof useElectionForm>["dispatch"]
