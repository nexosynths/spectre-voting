import { ethers } from "hardhat"

/**
 * Deploy SpectreVoting infrastructure to Base mainnet.
 *
 * Deploys:
 *   1. SpectreVoteVerifier (Groth16 vote proof verifier)
 *   2. AnonJoinVerifier (Groth16 anonymous join proof verifier)
 *   3. SpectreVotingFactory (two verifiers, signup deadline, numOptions)
 *
 * Re-uses existing:
 *   - Semaphore V4: 0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D (official CREATE2 deployment)
 */
async function main() {
    const [deployer] = await ethers.getSigners()
    console.log("Deploying with:", deployer.address)

    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("Balance:", ethers.formatEther(balance), "ETH\n")

    // Official Semaphore V4 on Base (deterministic CREATE2 — same on all chains)
    const SEMAPHORE = "0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D"

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
    console.log("\nView on Basescan:")
    console.log(`  https://basescan.org/address/${factoryAddr}`)
    console.log("\nUpdate apps/web-app/src/lib/contracts.ts with:")
    console.log(`  FACTORY: "${factoryAddr}",`)
    console.log(`  SEMAPHORE: "${SEMAPHORE}",`)
    console.log(`  VOTE_VERIFIER: "${voteVerifierAddr}",`)
    console.log(`  JOIN_VERIFIER: "${joinVerifierAddr}",`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
