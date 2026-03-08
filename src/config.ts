export type Config = {
    readonly port: number
    readonly databaseUrl: string
    readonly heartbeatMs: number
    /** Required — every /events request must carry a valid Supabase JWT. */
    readonly jwtSecret: string
    /**
     * When set, the JWT `aud` claim must equal this value.
     * Leave unset to skip audience validation.
     */
    readonly jwtAudience: string | null
    /** Allowed CORS origin, e.g. "https://app.example.com". "*" to allow all. */
    readonly corsOrigin: string
    /** Maximum channels a single connection may subscribe to. */
    readonly maxChannels: number
    /** Maximum concurrent SSE connections a single user may hold. */
    readonly maxConnectionsPerUser: number
    /** Hard ceiling on total concurrent SSE connections across all users. */
    readonly maxTotalConnections: number
    /** Maximum /events requests accepted per IP per minute (sliding window). */
    readonly rateLimitPerMinute: number
}

function requireEnv(key: string): string {
    const value = process.env[key]
    if (!value) {
        console.error(`[fatal] ${key} is required`)
        process.exit(1)
    }
    return value
}

function optionalEnv(key: string, fallback: string): string {
    return process.env[key] ?? fallback
}

export function loadConfig(): Config {
    return {
        port: Number(optionalEnv('PORT', '3000')),
        databaseUrl: requireEnv('DATABASE_URL'),
        heartbeatMs: Number(optionalEnv('SSE_HEARTBEAT_MS', '15000')),
        jwtSecret: requireEnv('SUPABASE_JWT_SECRET'),
        jwtAudience: process.env.SUPABASE_JWT_AUDIENCE ?? null,
        corsOrigin: optionalEnv('CORS_ORIGIN', '*'),
        maxChannels: Number(optionalEnv('MAX_CHANNELS_PER_CONNECTION', '10')),
        maxConnectionsPerUser: Number(optionalEnv('MAX_CONNECTIONS_PER_USER', '10')),
        maxTotalConnections: Number(optionalEnv('MAX_TOTAL_CONNECTIONS', '1000')),
        rateLimitPerMinute: Number(optionalEnv('RATE_LIMIT_PER_MINUTE', '30')),
    }
}
