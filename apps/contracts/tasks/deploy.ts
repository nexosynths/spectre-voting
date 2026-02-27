import { task, types } from "hardhat/config"

task("deploy", "Deploy SpectreVoting contract with verifier")
    .addOptionalParam("semaphore", "Semaphore contract address", undefined, types.string)
    .addOptionalParam("verifier", "SpectreVoteVerifier contract address", undefined, types.string)
    .addOptionalParam("proposalid", "Proposal ID for this election", "1", types.string)
    .addOptionalParam("pubkeyx", "Election ECIES public key X", "0", types.string)
    .addOptionalParam("pubkeyy", "Election ECIES public key Y", "0", types.string)
    .addOptionalParam("logs", "Print the logs", true, types.boolean)
    .setAction(
        async (
            { logs, semaphore: semaphoreAddress, verifier: verifierAddress, proposalid, pubkeyx, pubkeyy },
            { ethers, run }
        ) => {
            // Deploy Semaphore if no address provided
            if (!semaphoreAddress) {
                const { semaphore } = await run("deploy:semaphore", { logs })
                semaphoreAddress = await semaphore.getAddress()
            }

            // Deploy SpectreVoteVerifier if no address provided
            if (!verifierAddress) {
                const VerifierFactory = await ethers.getContractFactory("Groth16Verifier")
                const verifierContract = await VerifierFactory.deploy()
                verifierAddress = await verifierContract.getAddress()

                if (logs) {
                    console.info(`SpectreVoteVerifier deployed to: ${verifierAddress}`)
                }
            }

            // Deploy SpectreVoting
            // _admin = address(0) → constructor defaults to msg.sender
            const SpectreVotingFactory = await ethers.getContractFactory("SpectreVoting")
            const spectreVoting = await SpectreVotingFactory.deploy(
                semaphoreAddress,
                verifierAddress,
                proposalid,
                pubkeyx,
                pubkeyy,
                ethers.ZeroAddress,
                0 // no deadline for direct deploy — admin close only
            )

            if (logs) {
                console.info(`SpectreVoting deployed to: ${await spectreVoting.getAddress()}`)
            }

            return spectreVoting
        }
    )
