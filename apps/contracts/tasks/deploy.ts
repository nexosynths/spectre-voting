import { task, types } from "hardhat/config"

// Official Semaphore V4 deployment (deterministic CREATE2 address, live on Base mainnet)
export const DEFAULT_SEMAPHORE_ADDRESS = "0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D"

const LOCAL_NETWORKS = ["hardhat", "localhost"]

task("deploy", "Deploy Spectre v9: PoseidonT3, both Groth16 verifiers and SpectreVotingFactory")
    .addOptionalParam("semaphore", "Semaphore V4 address (default: the official deployment)", undefined, types.string)
    .addOptionalParam("poseidon", "Existing PoseidonT3 library address to reuse", undefined, types.string)
    .addOptionalParam("logs", "Print the logs", true, types.boolean)
    .setAction(async ({ logs, semaphore: semaphoreArg, poseidon: poseidonArg }, { ethers, run, network }) => {
        const log = (...args: unknown[]) => {
            if (logs) console.info(...args)
        }

        const [deployer] = await ethers.getSigners()
        const { chainId } = await ethers.provider.getNetwork()
        log(`Network: ${network.name} (chain ${chainId})`)
        log(`Deployer: ${deployer.address}`)
        log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`)

        const hasCode = async (address: string) => (await ethers.provider.getCode(address)) !== "0x"

        // 1. Semaphore: reuse the official deployment; on a local network deploy one if it's missing
        let semaphoreAddress: string = semaphoreArg || DEFAULT_SEMAPHORE_ADDRESS
        if (!(await hasCode(semaphoreAddress))) {
            if (semaphoreArg || !LOCAL_NETWORKS.includes(network.name)) {
                throw new Error(`No contract at Semaphore address ${semaphoreAddress} on ${network.name}`)
            }
            const { semaphore } = await run("deploy:semaphore", { logs: false })
            semaphoreAddress = await semaphore.getAddress()
            log(`Semaphore (local):    ${semaphoreAddress}`)
        } else {
            log(`Semaphore (existing): ${semaphoreAddress}`)
        }

        // 2. PoseidonT3 library (SpectreVoting hashes weighted leaves with it)
        let poseidonAddress: string
        if (poseidonArg) {
            if (!(await hasCode(poseidonArg))) throw new Error(`No contract at PoseidonT3 address ${poseidonArg}`)
            poseidonAddress = poseidonArg
            log(`PoseidonT3 (existing): ${poseidonAddress}`)
        } else {
            const poseidonT3 = await (await ethers.getContractFactory("PoseidonT3")).deploy()
            await poseidonT3.waitForDeployment()
            poseidonAddress = await poseidonT3.getAddress()
            log(`PoseidonT3:           ${poseidonAddress}`)
        }

        // 3. Groth16 verifiers (must match the proving keys the web app serves)
        const voteVerifier = await (await ethers.getContractFactory("SpectreVoteVerifier")).deploy()
        await voteVerifier.waitForDeployment()
        const voteVerifierAddress = await voteVerifier.getAddress()
        log(`SpectreVoteVerifier:  ${voteVerifierAddress}`)

        const joinVerifier = await (await ethers.getContractFactory("AnonJoinVerifier")).deploy()
        await joinVerifier.waitForDeployment()
        const joinVerifierAddress = await joinVerifier.getAddress()
        log(`AnonJoinVerifier:     ${joinVerifierAddress}`)

        // 4. Factory, linked with PoseidonT3
        const FactoryFactory = await ethers.getContractFactory("SpectreVotingFactory", {
            libraries: { PoseidonT3: poseidonAddress }
        })
        const factory = await FactoryFactory.deploy(semaphoreAddress, voteVerifierAddress, joinVerifierAddress)
        await factory.waitForDeployment()
        const factoryAddress = await factory.getAddress()
        const receipt = await factory.deploymentTransaction()!.wait()
        const deployBlock = receipt!.blockNumber
        log(`SpectreVotingFactory: ${factoryAddress} (block ${deployBlock})`)

        log("\nUpdate apps/web-app/src/lib/contracts.ts:")
        log(`    CONTRACTS.FACTORY: "${factoryAddress}"`)
        log(`    CONTRACTS.SEMAPHORE: "${semaphoreAddress}"`)
        log(`    FACTORY_DEPLOY_BLOCK = ${deployBlock}`)
        log("\nFor the README's deployed-contracts table:")
        log(`    SpectreVoteVerifier: ${voteVerifierAddress}`)
        log(`    AnonJoinVerifier:    ${joinVerifierAddress}`)
        log(`    PoseidonT3:          ${poseidonAddress}`)

        return {
            factory,
            factoryAddress,
            semaphoreAddress,
            poseidonAddress,
            voteVerifierAddress,
            joinVerifierAddress,
            deployBlock
        }
    })
