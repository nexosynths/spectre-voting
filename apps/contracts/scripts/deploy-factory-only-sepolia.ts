import { ethers } from "hardhat"

/**
 * Deploy ONLY the SpectreVotingFactory to Sepolia.
 * Re-uses existing Semaphore, VoteVerifier, and JoinVerifier.
 */
async function main() {
    const [deployer] = await ethers.getSigners()
    console.log("Deploying with:", deployer.address)

    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("Balance:", ethers.formatEther(balance), "ETH\n")

    // Existing shared infrastructure on Sepolia
    const SEMAPHORE = "0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D"
    const VOTE_VERIFIER = "0xe4a2be410766bCB37Df956334869135fe80AF36d"
    const JOIN_VERIFIER = "0xdeE4c3F80332119f59940c363947865bbF7d0585"

    console.log("Deploying SpectreVotingFactory (v3.1: gated signup)...")
    console.log("  Semaphore:", SEMAPHORE)
    console.log("  VoteVerifier:", VOTE_VERIFIER)
    console.log("  JoinVerifier:", JOIN_VERIFIER)

    const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory")
    const factory = await FactoryFactory.deploy(SEMAPHORE, VOTE_VERIFIER, JOIN_VERIFIER)
    await factory.waitForDeployment()
    const factoryAddr = await factory.getAddress()

    console.log("\n=== Deployment Complete ===")
    console.log("SpectreVotingFactory: ", factoryAddr)
    console.log("\nView on Etherscan:")
    console.log(`  https://sepolia.etherscan.io/address/${factoryAddr}`)
    console.log("\nUpdate apps/web-app/src/lib/contracts.ts:")
    console.log(`  FACTORY: "${factoryAddr}",`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
