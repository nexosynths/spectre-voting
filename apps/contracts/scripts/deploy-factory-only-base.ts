import { ethers } from "hardhat"

/**
 * Deploy ONLY the SpectreVotingFactory to Base mainnet.
 * Re-uses existing Semaphore (official V4) and already-deployed verifiers.
 */
async function main() {
    const [deployer] = await ethers.getSigners()
    console.log("Deploying with:", deployer.address)

    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("Balance:", ethers.formatEther(balance), "ETH\n")

    const SEMAPHORE = "0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D"
    const VOTE_VERIFIER = "0xfCDE99ac31eE5cb3Bd4DD2cD9E0D49f9c8240564"
    const JOIN_VERIFIER = "0xD11fF7e4739736769703f88501c1c4681675676d"

    console.log("Deploying SpectreVotingFactory...")
    console.log("  Semaphore:", SEMAPHORE)
    console.log("  VoteVerifier:", VOTE_VERIFIER)
    console.log("  JoinVerifier:", JOIN_VERIFIER)

    const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory")
    const factory = await FactoryFactory.deploy(SEMAPHORE, VOTE_VERIFIER, JOIN_VERIFIER)
    await factory.waitForDeployment()
    const factoryAddr = await factory.getAddress()

    console.log("\n=== Deployment Complete ===")
    console.log("SpectreVotingFactory: ", factoryAddr)
    console.log("\nView on Basescan:")
    console.log(`  https://basescan.org/address/${factoryAddr}`)
    console.log("\nUpdate apps/web-app/src/lib/contracts.ts:")
    console.log(`  FACTORY: "${factoryAddr}",`)
    console.log(`  SEMAPHORE: "${SEMAPHORE}",`)
    console.log(`  VOTE_VERIFIER: "${VOTE_VERIFIER}",`)
    console.log(`  JOIN_VERIFIER: "${JOIN_VERIFIER}",`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
