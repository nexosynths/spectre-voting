declare module "snarkjs" {
    export const groth16: {
        fullProve(
            input: Record<string, any>,
            wasmFile: string,
            zkeyFile: string
        ): Promise<{
            proof: {
                pi_a: string[]
                pi_b: string[][]
                pi_c: string[]
                protocol: string
                curve: string
            }
            publicSignals: string[]
        }>
        verify(
            vkey: any,
            publicSignals: string[],
            proof: any
        ): Promise<boolean>
    }
}
