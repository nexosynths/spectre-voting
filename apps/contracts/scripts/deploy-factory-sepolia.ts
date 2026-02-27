import { ethers } from "hardhat"

/**
 * Deploy SpectreVotingFactory to Sepolia.
 *
 * Re-uses the existing shared infrastructure:
 *   - Semaphore:        0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D
 *   - Groth16Verifier:  0xC1d7A22595b2661C4989BA268e4583441Cb31BB4
 *
 * The factory only needs these two addresses — it deploys new SpectreVoting
 * instances on demand via createElection().
 */
async function main() {
    const [deployer] = await ethers.getSigners()
    console.log("Deploying with:", deployer.address)

    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("Balance:", ethers.formatEther(balance), "ETH\n")

    // Existing shared infrastructure on Sepolia
    const SEMAPHORE = "0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D"
    const VERIFIER = "0xC1d7A22595b2661C4989BA268e4583441Cb31BB4"

    console.log("Deploying SpectreVotingFactory...")
    console.log("  Semaphore:", SEMAPHORE)
    console.log("  Verifier: ", VERIFIER)

    const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory")
    const factory = await FactoryFactory.deploy(SEMAPHORE, VERIFIER)
    await factory.waitForDeployment()

    const factoryAddr = await factory.getAddress()

    console.log("\n=== Deployment Complete ===")
    console.log("SpectreVotingFactory:", factoryAddr)
    console.log("\nView on Etherscan:")
    console.log(`  https://sepolia.etherscan.io/address/${factoryAddr}`)
    console.log("\nAnyone can now create elections via:")
    console.log("  factory.createElection(proposalId, pubKeyX, pubKeyY, votingDeadline)")
    console.log("  (votingDeadline = unix timestamp, 0 = no deadline / admin-only close)")
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
