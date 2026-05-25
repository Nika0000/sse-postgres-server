import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { verifyJwt, extractToken, initJwks, _resetKeyCache } from '../auth.ts'
import type { Config } from '../config.ts'
import { serve } from 'bun'

let keyPair: CryptoKeyPair
let jwkPublic: JsonWebKey
let jwksServer: ReturnType<typeof serve>
let jwksUrl: string

const KID = 'test-key-1'

let BASE_CONFIG: Config

beforeAll(async () => {
    keyPair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify']
    )
    jwkPublic = await crypto.subtle.exportKey('jwk', keyPair.publicKey)

    jwksServer = serve({
        port: 0,
        fetch() {
            return new Response(
                JSON.stringify({
                    keys: [{ ...jwkPublic, kid: KID, alg: 'RS256', use: 'sig' }],
                }),
                { headers: { 'Content-Type': 'application/json' } }
            )
        },
    })

    jwksUrl = `http://localhost:${jwksServer.port}/.well-known/jwks.json`
    BASE_CONFIG = {
        port: 3000,
        databaseUrl: 'postgres://localhost/test',
        heartbeatMs: 15_000,
        jwksUrl,
        jwtAudience: null,
        corsOrigin: '*',
        maxChannels: 10,
        maxConnectionsPerUser: 10,
        maxTotalConnections: 1000,
        rateLimitPerMinute: 30,
        eventBufferSize: 100,
        eventBufferTtlMs: 300_000,
    }
    await initJwks(BASE_CONFIG)
})

afterAll(() => {
    jwksServer?.stop()
})

afterEach(() => {
    _resetKeyCache()
})

function b64url(data: Uint8Array | string): string {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    return btoa(String.fromCharCode(...bytes))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function buildToken(
    claims: Record<string, unknown>,
    kid = KID
): Promise<string> {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
    const payload = b64url(JSON.stringify(claims))

    const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keyPair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`)
    )
    const sigB64 = b64url(new Uint8Array(sig))
    return `${header}.${payload}.${sigB64}`
}

function nowSecs(): number {
    return Math.floor(Date.now() / 1000)
}

describe('verifyJwt (JWKS)', () => {
    test('returns user for a valid token', async () => {
        await initJwks(BASE_CONFIG)
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
        await initJwks(BASE_CONFIG)
        expect(await verifyJwt('not.a.jwt', BASE_CONFIG)).toBeNull()
        expect(await verifyJwt('only-one-part', BASE_CONFIG)).toBeNull()
    })

    test('returns null for an expired token', async () => {
        await initJwks(BASE_CONFIG)
        const token = await buildToken({
            sub: 'u',
            role: 'authenticated',
            aud: 'authenticated',
            exp: nowSecs() - 60,
            iat: nowSecs() - 120,
        })
        expect(await verifyJwt(token, BASE_CONFIG)).toBeNull()
    })

    test('returns null for unknown kid', async () => {
        await initJwks(BASE_CONFIG)
        const token = await buildToken(
            { sub: 'u', role: 'authenticated', aud: 'authenticated', exp: nowSecs() + 3600, iat: nowSecs() },
            'nonexistent-kid'
        )
        expect(await verifyJwt(token, BASE_CONFIG)).toBeNull()
    })

    test('returns null when kid is missing from header', async () => {
        await initJwks(BASE_CONFIG)
        const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
        const payload = b64url(JSON.stringify({
            sub: 'u', role: 'authenticated', exp: nowSecs() + 3600, iat: nowSecs(),
        }))
        const sig = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            keyPair.privateKey,
            new TextEncoder().encode(`${header}.${payload}`)
        )
        const token = `${header}.${payload}.${b64url(new Uint8Array(sig))}`
        expect(await verifyJwt(token, BASE_CONFIG)).toBeNull()
    })

    test('validates audience when configured', async () => {
        await initJwks(BASE_CONFIG)
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

    test('defaults role to authenticated when claim is missing', async () => {
        await initJwks(BASE_CONFIG)
        const token = await buildToken({
            sub: 'u',
            aud: 'authenticated',
            exp: nowSecs() + 3600,
            iat: nowSecs(),
        })
        const user = await verifyJwt(token, BASE_CONFIG)
        expect(user?.role).toBe('authenticated')
    })
})

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
