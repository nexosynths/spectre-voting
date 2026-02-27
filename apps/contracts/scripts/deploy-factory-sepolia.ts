import { ethers } from "hardhat"

/**
 * Deploy SpectreVoting v3 infrastructure to Sepolia.
 *
 * Deploys:
 *   1. SpectreVoteVerifier (new — 5 public signals with numOptions)
 *   2. AnonJoinVerifier (new — anonymous join ZK proof verifier)
 *   3. SpectreVotingFactory (new — two verifiers, signup deadline, numOptions)
 *
 * Re-uses existing:
 *   - Semaphore: 0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D
 */
async function main() {
    const [deployer] = await ethers.getSigners()
    console.log("Deploying with:", deployer.address)

    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("Balance:", ethers.formatEther(balance), "ETH\n")

    // Existing shared infrastructure on Sepolia
    const SEMAPHORE = "0xb57FD6C1A5201cCc822416D86b281E0F0F7D2c3D"

    // 1. Deploy SpectreVoteVerifier
    console.log("Deploying SpectreVoteVerifier...")
    const VoteVerifierFactory = await ethers.getContractFactory("SpectreVoteVerifier")
    const voteVerifier = await VoteVerifierFactory.deploy()
    await voteVerifier.waitForDeployment()
    const voteVerifierAddr = await voteVerifier.getAddress()
    console.log("  SpectreVoteVerifier:", voteVerifierAddr)

    // 2. Deploy AnonJoinVerifier
    console.log("Deploying AnonJoinVerifier...")
    const JoinVerifierFactory = await ethers.getContractFactory("AnonJoinVerifier")
    const joinVerifier = await JoinVerifierFactory.deploy()
    await joinVerifier.waitForDeployment()
    const joinVerifierAddr = await joinVerifier.getAddress()
    console.log("  AnonJoinVerifier:", joinVerifierAddr)

    // 3. Deploy SpectreVotingFactory
    console.log("Deploying SpectreVotingFactory...")
    console.log("  Semaphore:", SEMAPHORE)
    console.log("  VoteVerifier:", voteVerifierAddr)
    console.log("  JoinVerifier:", joinVerifierAddr)

    const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory")
    const factory = await FactoryFactory.deploy(SEMAPHORE, voteVerifierAddr, joinVerifierAddr)
    await factory.waitForDeployment()
    const factoryAddr = await factory.getAddress()

    console.log("\n=== Deployment Complete ===")
    console.log("Semaphore (existing): ", SEMAPHORE)
    console.log("SpectreVoteVerifier:  ", voteVerifierAddr)
    console.log("AnonJoinVerifier:     ", joinVerifierAddr)
    console.log("SpectreVotingFactory: ", factoryAddr)
    console.log("\nView on Etherscan:")
    console.log(`  https://sepolia.etherscan.io/address/${factoryAddr}`)
    console.log("\nUpdate apps/web-app/src/lib/contracts.ts with:")
    console.log(`  FACTORY: "${factoryAddr}",`)
    console.log(`  VOTE_VERIFIER: "${voteVerifierAddr}",`)
    console.log(`  JOIN_VERIFIER: "${joinVerifierAddr}",`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
