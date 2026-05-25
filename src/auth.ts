import type { Config } from './config.ts'
import type { AuthUser } from './types.ts'
import { logger } from './logger.ts'

type JwkKey = {
    readonly kty: string
    readonly kid: string
    readonly alg: string
    readonly use?: string
    readonly n?: string
    readonly e?: string
    readonly crv?: string
    readonly x?: string
    readonly y?: string
}

type JwksResponse = {
    readonly keys: JwkKey[]
}

type JwtHeader = {
    readonly alg: string
    readonly kid?: string
    readonly typ?: string
}

type JwtClaims = {
    readonly sub: string
    readonly email?: string
    readonly role?: string
    readonly aud?: string | string[]
    readonly exp: number
    readonly iat: number
}

const ALG_PARAMS: Record<string, { import: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams }> = {
    RS256: {
        import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        verify: { name: 'RSASSA-PKCS1-v1_5' },
    },
    RS384: {
        import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
        verify: { name: 'RSASSA-PKCS1-v1_5' },
    },
    RS512: {
        import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
        verify: { name: 'RSASSA-PKCS1-v1_5' },
    },
    ES256: {
        import: { name: 'ECDSA', namedCurve: 'P-256' },
        verify: { name: 'ECDSA', hash: 'SHA-256' },
    },
    ES384: {
        import: { name: 'ECDSA', namedCurve: 'P-384' },
        verify: { name: 'ECDSA', hash: 'SHA-384' },
    },
}

type CachedKey = {
    readonly cryptoKey: CryptoKey
    readonly alg: string
}

let cachedKeys = new Map<string, CachedKey>()
let lastFetchMs = 0
const MIN_REFETCH_MS = 30_000

async function fetchJwks(config: Config): Promise<void> {
    const res = await fetch(config.jwksUrl)
    if (!res.ok) {
        throw new Error(`JWKS fetch failed: ${res.status}`)
    }
    const jwks: JwksResponse = await res.json()
    const newKeys = new Map<string, CachedKey>()

    for (const jwk of jwks.keys) {
        if (jwk.use && jwk.use !== 'sig') continue
        const params = ALG_PARAMS[jwk.alg]
        if (!params) continue

        try {
            const cryptoKey = await crypto.subtle.importKey(
                'jwk',
                jwk as JsonWebKey,
                params.import,
                false,
                ['verify']
            )
            newKeys.set(jwk.kid, { cryptoKey, alg: jwk.alg })
        } catch (err) {
            logger.warn({ kid: jwk.kid, alg: jwk.alg, err }, '[jwks] failed to import key')
        }
    }

    cachedKeys = newKeys
    lastFetchMs = Date.now()
    logger.info({ keys: newKeys.size }, '[jwks] keys loaded')
}

async function getKey(kid: string, config: Config): Promise<CachedKey | null> {
    let key = cachedKeys.get(kid) ?? null
    if (key) return key

    // Key not found — refetch if enough time has passed (key rotation)
    if (Date.now() - lastFetchMs > MIN_REFETCH_MS) {
        await fetchJwks(config)
        key = cachedKeys.get(kid) ?? null
    }
    return key
}

export async function initJwks(config: Config): Promise<void> {
    await fetchJwks(config)
}

function b64url(s: string): Uint8Array {
    return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0)
    )
}

export async function verifyJwt(
    token: string,
    config: Config
): Promise<AuthUser | null> {
    try {
        const parts = token.split('.')
        if (parts.length !== 3) return null

        const header: JwtHeader = JSON.parse(
            new TextDecoder().decode(b64url(parts[0]!))
        )

        if (!header.kid) return null

        const cached = await getKey(header.kid, config)
        if (!cached) return null

        // Use the algorithm from the trusted JWKS key, not the untrusted JWT header
        const params = ALG_PARAMS[cached.alg]
        if (!params) return null

        const signature = b64url(parts[2]!)
        const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)

        const valid = await crypto.subtle.verify(
            params.verify,
            cached.cryptoKey,
            signature.buffer as ArrayBuffer,
            data
        )
        if (!valid) return null

        const claims: JwtClaims = JSON.parse(
            new TextDecoder().decode(b64url(parts[1]!))
        )

        if (claims.exp < Math.floor(Date.now() / 1000)) return null

        if (config.jwtAudience !== null) {
            const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
            if (!aud.includes(config.jwtAudience)) return null
        }

        return {
            id: claims.sub,
            email: claims.email ?? null,
            role: claims.role ?? 'authenticated',
            expiresAt: claims.exp * 1000,
        }
    } catch {
        return null
    }
}

/**
 * Extract a bearer token from the request.
 * Checks the Authorization header first, then the `token` query param.
 * The query param exists because `EventSource` cannot set custom headers.
 */
export function extractToken(request: Request, url: URL): string | null {
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
    return url.searchParams.get('token')
}

// For testing: reset cached keys
export function _resetKeyCache(): void {
    cachedKeys = new Map()
    lastFetchMs = 0
}
