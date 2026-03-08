import { describe, test, expect } from 'vitest'
import { verifyJwt, extractToken } from '../auth.ts'
import type { Config } from '../config.ts'

const SECRET = 'super-secret-jwt-key-for-tests-only'

const BASE_CONFIG: Config = {
    port: 3000,
    databaseUrl: 'postgres://localhost/test',
    heartbeatMs: 15_000,
    jwtSecret: SECRET,
    jwtAudience: null,
    corsOrigin: '*',
    maxChannels: 10,
    maxConnectionsPerUser: 10,
    maxTotalConnections: 1000,
    rateLimitPerMinute: 30,
}

async function buildToken(
    claims: Record<string, unknown>,
    secret = SECRET
): Promise<string> {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const payload = btoa(JSON.stringify(claims))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )
    const sig = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${header}.${payload}`)
    )
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    return `${header}.${payload}.${sigB64}`
}

function nowSecs(): number {
    return Math.floor(Date.now() / 1000)
}

// verifyJwt
describe('verifyJwt', () => {
    test('returns user for a valid token', async () => {
        const token = await buildToken({
            sub: 'user-uuid',
            email: 'a@b.com',
            role: 'authenticated',
            aud: 'authenticated',
            exp: nowSecs() + 3600,
            iat: nowSecs(),
        })
        const user = await verifyJwt(token, BASE_CONFIG)
        expect(user).not.toBeNull()
        expect(user?.id).toBe('user-uuid')
        expect(user?.email).toBe('a@b.com')
        expect(user?.role).toBe('authenticated')
    })

    test('returns null for a malformed token', async () => {
        expect(await verifyJwt('not.a.jwt', BASE_CONFIG)).toBeNull()
        expect(await verifyJwt('only-one-part', BASE_CONFIG)).toBeNull()
    })

    test('returns null for an expired token', async () => {
        const token = await buildToken({
            sub: 'u',
            role: 'authenticated',
            aud: 'authenticated',
            exp: nowSecs() - 60,
            iat: nowSecs() - 120,
        })
        expect(await verifyJwt(token, BASE_CONFIG)).toBeNull()
    })

    test('returns null when signature is wrong', async () => {
        const token = await buildToken(
            { sub: 'u', role: 'authenticated', aud: 'authenticated', exp: nowSecs() + 3600, iat: nowSecs() },
            'wrong-secret'
        )
        expect(await verifyJwt(token, BASE_CONFIG)).toBeNull()
    })

    test('validates audience when configured', async () => {
        const token = await buildToken({
            sub: 'u',
            role: 'authenticated',
            aud: 'authenticated',
            exp: nowSecs() + 3600,
            iat: nowSecs(),
        })
        const withAud: Config = { ...BASE_CONFIG, jwtAudience: 'authenticated' }
        expect(await verifyJwt(token, withAud)).not.toBeNull()

        const wrongAud: Config = { ...BASE_CONFIG, jwtAudience: 'service_role' }
        expect(await verifyJwt(token, wrongAud)).toBeNull()
    })

    test('maps app_metadata and user_metadata', async () => {
        const token = await buildToken({
            sub: 'u',
            role: 'authenticated',
            aud: 'authenticated',
            exp: nowSecs() + 3600,
            iat: nowSecs(),
            app_metadata: { org_id: 'acme' },
            user_metadata: { theme: 'dark' },
        })
        const user = await verifyJwt(token, BASE_CONFIG)
        expect(user?.appMetadata).toEqual({ org_id: 'acme' })
        expect(user?.userMetadata).toEqual({ theme: 'dark' })
    })
})

// extractToken
describe('extractToken', () => {
    test('reads from Authorization header', () => {
        const req = new Request('http://localhost/events', {
            headers: { Authorization: 'Bearer my-token' },
        })
        expect(extractToken(req, new URL(req.url))).toBe('my-token')
    })

    test('reads from ?token= query param', () => {
        const req = new Request('http://localhost/events?token=my-token')
        expect(extractToken(req, new URL(req.url))).toBe('my-token')
    })

    test('prefers Authorization header over query param', () => {
        const req = new Request('http://localhost/events?token=query-token', {
            headers: { Authorization: 'Bearer header-token' },
        })
        expect(extractToken(req, new URL(req.url))).toBe('header-token')
    })

    test('returns null when no token present', () => {
        const req = new Request('http://localhost/events')
        expect(extractToken(req, new URL(req.url))).toBeNull()
    })
})
