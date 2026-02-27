import { ethers } from "hardhat"

async function main() {
    const [deployer] = await ethers.getSigners()
    console.log("Deploying with:", deployer.address)

    const balance = await ethers.provider.getBalance(deployer.address)
    console.log("Balance:", ethers.formatEther(balance), "ETH\n")

    // 1. Deploy SemaphoreVerifier (Semaphore's Groth16 verifier for its own circuit)
    console.log("1/5 Deploying SemaphoreVerifier...")
    const SemaphoreVerifierFactory = await ethers.getContractFactory("SemaphoreVerifier", {
        libraries: {}
    })
    // Try importing from semaphore hardhat plugin
    const { semaphore: semaphoreContract } = await import("@semaphore-protocol/hardhat").then(async (mod) => {
        // Use the hardhat task instead
        throw new Error("skip")
    }).catch(async () => {
        // Manual deployment with confirmations

        // 1. Poseidon library
        console.log("1/5 Deploying PoseidonT3 library...")
        const PoseidonT3Factory = await ethers.getContractFactory("PoseidonT3")
        const poseidonT3 = await PoseidonT3Factory.deploy()
        await poseidonT3.waitForDeployment()
        const poseidonAddr = await poseidonT3.getAddress()
        console.log("  PoseidonT3:", poseidonAddr)

        // Wait for confirmation
        await new Promise(r => setTimeout(r, 5000))

        // 2. SemaphoreVerifier
        console.log("2/5 Deploying SemaphoreVerifier...")
        const SVFactory = await ethers.getContractFactory("SemaphoreVerifier")
        const sv = await SVFactory.deploy()
        await sv.waitForDeployment()
        const svAddr = await sv.getAddress()
        console.log("  SemaphoreVerifier:", svAddr)

        await new Promise(r => setTimeout(r, 5000))

        // 3. Semaphore (linked to PoseidonT3 + SemaphoreVerifier)
        console.log("3/5 Deploying Semaphore...")
        const SemaphoreFactory = await ethers.getContractFactory("Semaphore", {
            libraries: { PoseidonT3: poseidonAddr }
        })
        const semaphore = await SemaphoreFactory.deploy(svAddr)
        await semaphore.waitForDeployment()
        const semaphoreAddr = await semaphore.getAddress()
        console.log("  Semaphore:", semaphoreAddr)

        await new Promise(r => setTimeout(r, 5000))

        return { semaphore }
    })

    const semaphoreAddr = await semaphoreContract.getAddress()

    // 4. SpectreVoteVerifier (our custom Groth16 verifier)
    console.log("4/5 Deploying Groth16Verifier (SpectreVote circuit)...")
    const VerifierFactory = await ethers.getContractFactory("Groth16Verifier")
    const verifier = await VerifierFactory.deploy()
    await verifier.waitForDeployment()
    const verifierAddr = await verifier.getAddress()
    console.log("  Groth16Verifier:", verifierAddr)

    await new Promise(r => setTimeout(r, 5000))

    // 5. SpectreVoting
    const PROPOSAL_ID = 1
    const ELECTION_PUBKEY_X = 0 // placeholder — set during election setup
    const ELECTION_PUBKEY_Y = 0

    console.log("5/5 Deploying SpectreVoting...")
    const SpectreVotingFactory = await ethers.getContractFactory("SpectreVoting")
    const spectreVoting = await SpectreVotingFactory.deploy(
        semaphoreAddr,
        verifierAddr,
        PROPOSAL_ID,
        ELECTION_PUBKEY_X,
        ELECTION_PUBKEY_Y
    )
    await spectreVoting.waitForDeployment()
    const spectreVotingAddr = await spectreVoting.getAddress()
    console.log("  SpectreVoting:", spectreVotingAddr)

    console.log("\n=== Deployment Complete ===")
    console.log("Semaphore:       ", semaphoreAddr)
    console.log("Groth16Verifier: ", verifierAddr)
    console.log("SpectreVoting:   ", spectreVotingAddr)
    console.log("\nView on Etherscan:")
    console.log(`  https://sepolia.etherscan.io/address/${spectreVotingAddr}`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
