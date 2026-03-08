import type { Config } from './config.ts'
import type { AuthUser } from './types.ts'

type SupabaseClaims = {
    readonly sub: string
    readonly email?: string
    readonly role: string
    readonly aud: string
    readonly exp: number
    readonly iat: number
    readonly app_metadata?: Record<string, unknown>
    readonly user_metadata?: Record<string, unknown>
}

/**
 * Verify a Supabase-issued HS256 JWT using the Web Crypto API (no extra dep).
 * Returns null on any failure — expired, invalid signature, malformed, etc.
 */
export async function verifyJwt(
    token: string,
    config: Config
): Promise<AuthUser | null> {
    try {
        const parts = token.split('.')
        if (parts.length !== 3) return null

        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(config.jwtSecret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        )

        const b64 = (s: string): Uint8Array =>
            Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
                c.charCodeAt(0)
            )

        const valid = await crypto.subtle.verify(
            'HMAC',
            key,
            b64(parts[2]!).buffer as ArrayBuffer,
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
        )
        if (!valid) return null

        const claims: SupabaseClaims = JSON.parse(
            new TextDecoder().decode(b64(parts[1]!))
        )

        // Reject expired tokens
        if (claims.exp < Math.floor(Date.now() / 1000)) return null

        // Reject if audience doesn't match (when configured)
        if (config.jwtAudience !== null && claims.aud !== config.jwtAudience) return null

        return {
            id: claims.sub,
            email: claims.email ?? null,
            role: claims.role,
            appMetadata: claims.app_metadata ?? {},
            userMetadata: claims.user_metadata ?? {},
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
