import { run } from "hardhat"

/**
 * Deploy Spectre v9: PoseidonT3, SpectreVoteVerifier, AnonJoinVerifier and
 * SpectreVotingFactory (linked with PoseidonT3), reusing an existing Semaphore V4.
 *
 * Usage (keys come from ETHEREUM_PRIVATE_KEY in the repo-root .env; never hardcode them):
 *   npx hardhat run scripts/deploy-factory.ts --network base
 *
 * Optional environment variables:
 *   SEMAPHORE_ADDRESS    Semaphore V4 address (default: the official deployment,
 *                        0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D). On the local
 *                        hardhat/localhost network a Semaphore is deployed if missing.
 *   POSEIDON_T3_ADDRESS  Existing PoseidonT3 library to reuse instead of deploying one.
 *
 * Prints every address plus the factory's deploy block for apps/web-app/src/lib/contracts.ts.
 */
async function main() {
    await run("deploy", {
        semaphore: process.env.SEMAPHORE_ADDRESS || undefined,
        poseidon: process.env.POSEIDON_T3_ADDRESS || undefined,
        logs: true
    })
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
