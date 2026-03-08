import { describe, test, expect } from 'vitest'
import { parseEnvRules } from '../channels/env-rules.ts'

function makeUser(overrides: Record<string, unknown> = {}) {
    return {
        id: 'user-1',
        email: 'alice@example.com',
        role: 'authenticated',
        appMetadata: {} as Record<string, unknown>,
        userMetadata: {},
        expiresAt: Date.now() + 3_600_000,
        ...overrides,
    }
}

// Parsing errors
describe('parseEnvRules — invalid input', () => {
    test('throws on invalid JSON', () => {
        expect(() => parseEnvRules('not json')).toThrow(/invalid JSON/)
    })

    test('throws when root is not an array', () => {
        expect(() => parseEnvRules('{}')).toThrow(/must be a JSON array/)
    })

    test('throws on unknown rule type', () => {
        expect(() => parseEnvRules('[{"type":"unknown_type"}]')).toThrow(/unknown type/)
    })

    test('throws when exact is missing channel', () => {
        expect(() => parseEnvRules('[{"type":"exact"}]')).toThrow(/"channel" must be a string/)
    })

    test('throws when role_gate is missing role', () => {
        expect(() =>
            parseEnvRules('[{"type":"role_gate","channel":"admin"}]')
        ).toThrow(/"role" must be a string/)
    })

    test('throws when meta_gate is missing key', () => {
        expect(() =>
            parseEnvRules('[{"type":"meta_gate","channel":"beta","value":true}]')
        ).toThrow(/"key" must be a string/)
    })

    test('throws when meta_gate is missing value', () => {
        expect(() =>
            parseEnvRules('[{"type":"meta_gate","channel":"beta","key":"beta_flag"}]')
        ).toThrow(/"value" is required/)
    })
})

// Built-in prefix descriptors
describe('parseEnvRules — built-in prefix rules', () => {
    test('user_prefix: owner-only access', () => {
        const engine = parseEnvRules('[{"type":"user_prefix"},{"type":"public"}]')
        const user = makeUser({ id: 'abc123' })
        expect(engine.check('user_abc123', user).allowed).toBe(true)
        expect(engine.check('user_other', user).allowed).toBe(false)
    })

    test('role_prefix: role must match suffix', () => {
        const engine = parseEnvRules('[{"type":"role_prefix"},{"type":"public"}]')
        const admin = makeUser({ role: 'admin' })
        expect(engine.check('role_admin', admin).allowed).toBe(true)
        expect(engine.check('role_admin', makeUser()).allowed).toBe(false)
    })

    test('org_prefix: app_metadata.org_id must match', () => {
        const engine = parseEnvRules('[{"type":"org_prefix"},{"type":"public"}]')
        const user = makeUser({ appMetadata: { org_id: '42' } })
        expect(engine.check('org_42', user).allowed).toBe(true)
        expect(engine.check('org_99', user).allowed).toBe(false)
    })

    test('private_prefix: any non-anon user passes', () => {
        const engine = parseEnvRules('[{"type":"private_prefix"},{"type":"public"}]')
        const user = makeUser()
        expect(engine.check('private_anything', user).allowed).toBe(true)
    })

    test('public: catch-all allow', () => {
        const engine = parseEnvRules('[{"type":"public"}]')
        expect(engine.check('any_channel', makeUser()).allowed).toBe(true)
    })

    test('deny_unlisted: catch-all deny', () => {
        const engine = parseEnvRules('[{"type":"deny_unlisted"}]')
        const result = engine.check('mystery', makeUser())
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(403)
    })
})

// Named-channel descriptors
describe('parseEnvRules — exact', () => {
    const engine = parseEnvRules('[{"type":"exact","channel":"announcements"},{"type":"deny_unlisted"}]')

    test('allows the named channel', () => {
        expect(engine.check('announcements', makeUser()).allowed).toBe(true)
    })

    test('denies any other channel via deny_unlisted catch-all', () => {
        expect(engine.check('other', makeUser()).allowed).toBe(false)
    })
})

describe('parseEnvRules — role_gate', () => {
    const engine = parseEnvRules(
        '[{"type":"role_gate","channel":"admin_events","role":"admin"},{"type":"deny_unlisted"}]'
    )
    const admin = makeUser({ role: 'admin' })
    const regular = makeUser()

    test('allows user with the required role', () => {
        expect(engine.check('admin_events', admin).allowed).toBe(true)
    })

    test('denies user with wrong role', () => {
        const result = engine.check('admin_events', regular)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(403)
    })
})

describe('parseEnvRules — meta_gate', () => {
    const engine = parseEnvRules(
        '[{"type":"meta_gate","channel":"beta_feed","key":"beta","value":true},{"type":"deny_unlisted"}]'
    )

    test('allows user with matching metadata', () => {
        const user = makeUser({ appMetadata: { beta: true } })
        expect(engine.check('beta_feed', user).allowed).toBe(true)
    })

    test('denies user without the flag', () => {
        const result = engine.check('beta_feed', makeUser())
        expect(result.allowed).toBe(false)
    })

    test('string value equality', () => {
        const e = parseEnvRules(
            '[{"type":"meta_gate","channel":"pro_feed","key":"plan","value":"pro"},{"type":"deny_unlisted"}]'
        )
        expect(e.check('pro_feed', makeUser({ appMetadata: { plan: 'pro' } })).allowed).toBe(true)
        expect(e.check('pro_feed', makeUser({ appMetadata: { plan: 'free' } })).allowed).toBe(false)
    })
})

// Custom prefix descriptors
describe('parseEnvRules — team_prefix', () => {
    const engine = parseEnvRules('[{"type":"team_prefix"},{"type":"deny_unlisted"}]')

    test('allows user whose team_id matches', () => {
        const user = makeUser({ appMetadata: { team_id: 7 } })
        expect(engine.check('team_7', user).allowed).toBe(true)
    })

    test('denies user from a different team', () => {
        const user = makeUser({ appMetadata: { team_id: 99 } })
        expect(engine.check('team_7', user).allowed).toBe(false)
    })
})

describe('parseEnvRules — plan_prefix', () => {
    const engine = parseEnvRules('[{"type":"plan_prefix"},{"type":"deny_unlisted"}]')

    test('allows matching plan', () => {
        const user = makeUser({ appMetadata: { plan: 'pro' } })
        expect(engine.check('plan_pro', user).allowed).toBe(true)
    })

    test('allows higher plan', () => {
        const user = makeUser({ appMetadata: { plan: 'enterprise' } })
        expect(engine.check('plan_pro', user).allowed).toBe(true)
    })

    test('denies lower plan', () => {
        const user = makeUser({ appMetadata: { plan: 'free' } })
        expect(engine.check('plan_pro', user).allowed).toBe(false)
    })
})

// Full compose.yml example
describe('parseEnvRules — compose.yml example (integration)', () => {
    const json = JSON.stringify([
        { type: 'exact', channel: 'announcements' },
        { type: 'exact', channel: 'global' },
        { type: 'exact', channel: 'status' },
        { type: 'role_gate', channel: 'admin_events', role: 'admin' },
        { type: 'meta_gate', channel: 'beta_features', key: 'beta', value: true },
        { type: 'meta_gate', channel: 'pro_feed', key: 'plan', value: 'pro' },
        { type: 'team_prefix' },
        { type: 'plan_prefix' },
        { type: 'user_prefix' },
        { type: 'role_prefix' },
        { type: 'org_prefix' },
        { type: 'private_prefix' },
        { type: 'deny_unlisted' },
    ])
    const engine = parseEnvRules(json)

    test('exact channels open to everyone', () => {
        expect(engine.check('announcements', makeUser()).allowed).toBe(true)
        expect(engine.check('global', makeUser()).allowed).toBe(true)
    })

    test('admin_events requires admin role', () => {
        expect(engine.check('admin_events', makeUser({ role: 'admin' })).allowed).toBe(true)
        expect(engine.check('admin_events', makeUser()).allowed).toBe(false)
    })

    test('beta_features requires beta metadata', () => {
        expect(engine.check('beta_features', makeUser({ appMetadata: { beta: true } })).allowed).toBe(true)
        expect(engine.check('beta_features', makeUser()).allowed).toBe(false)
    })

    test('team channel requires matching team_id', () => {
        expect(engine.check('team_5', makeUser({ appMetadata: { team_id: 5 } })).allowed).toBe(true)
        expect(engine.check('team_5', makeUser()).allowed).toBe(false)
    })

    test('user_ channel is owner-only', () => {
        expect(engine.check('user_user1', makeUser({ id: 'user1' })).allowed).toBe(true)
        expect(engine.check('user_other', makeUser()).allowed).toBe(false)
    })

    test('unlisted channel is denied', () => {
        expect(engine.check('mystery_channel', makeUser()).allowed).toBe(false)
    })
})
