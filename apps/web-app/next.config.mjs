/** @type {import('next').NextConfig} */
const nextConfig = {
    webpack: (config, { isServer }) => {
        // snarkjs and related libs reference Node.js modules
        // that aren't needed in the browser
        if (!isServer) {
            config.resolve.fallback = {
                ...config.resolve.fallback,
                fs: false,
                readline: false,
                net: false,
                tls: false,
                path: false,
                os: false,
                crypto: false,
                stream: false,
                constants: false,
                worker_threads: false,
            }
        }
        // BigInt support for snarkjs
        config.experiments = {
            ...config.experiments,
            topLevelAwait: true,
        }
        return config
    },
}

export default nextConfig
