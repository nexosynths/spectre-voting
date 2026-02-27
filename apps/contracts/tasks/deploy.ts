import { task, types } from "hardhat/config"

task("deploy", "Deploy SpectreVoting infrastructure (verifiers + factory)")
    .addOptionalParam("semaphore", "Semaphore contract address", undefined, types.string)
    .addOptionalParam("voteverifier", "SpectreVoteVerifier contract address", undefined, types.string)
    .addOptionalParam("joinverifier", "AnonJoinVerifier contract address", undefined, types.string)
    .addOptionalParam("logs", "Print the logs", true, types.boolean)
    .setAction(
        async (
            { logs, semaphore: semaphoreAddress, voteverifier: voteVerifierAddress, joinverifier: joinVerifierAddress },
            { ethers, run }
        ) => {
            // Deploy Semaphore if no address provided
            if (!semaphoreAddress) {
                const { semaphore } = await run("deploy:semaphore", { logs })
                semaphoreAddress = await semaphore.getAddress()
            }

            // Deploy SpectreVoteVerifier if no address provided
            if (!voteVerifierAddress) {
                const VoteVerifierFactory = await ethers.getContractFactory("SpectreVoteVerifier")
                const voteVerifier = await VoteVerifierFactory.deploy()
                voteVerifierAddress = await voteVerifier.getAddress()

                if (logs) {
                    console.info(`SpectreVoteVerifier deployed to: ${voteVerifierAddress}`)
                }
            }

            // Deploy AnonJoinVerifier if no address provided
            if (!joinVerifierAddress) {
                const JoinVerifierFactory = await ethers.getContractFactory("AnonJoinVerifier")
                const joinVerifier = await JoinVerifierFactory.deploy()
                joinVerifierAddress = await joinVerifier.getAddress()

                if (logs) {
                    console.info(`AnonJoinVerifier deployed to: ${joinVerifierAddress}`)
                }
            }

            // Deploy SpectreVotingFactory
            const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory")
            const factory = await FactoryFactory.deploy(
                semaphoreAddress,
                voteVerifierAddress,
                joinVerifierAddress
            )

            if (logs) {
                console.info(`SpectreVotingFactory deployed to: ${await factory.getAddress()}`)
            }

            return { factory, semaphoreAddress, voteVerifierAddress, joinVerifierAddress }
        }
    )
