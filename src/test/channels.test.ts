import { describe, test, expect } from 'vitest'
import {
    ChannelRuleEngine,
    defaultRules,
    userChannelRule,
    roleChannelRule,
    orgChannelRule,
    privateChannelRule,
    publicChannelRule,
} from '../channels/rules.ts'
import type { AuthUser } from '../types.ts'

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'user-uuid-1234',
        email: 'test@example.com',
        role: 'authenticated',
        appMetadata: {},
        userMetadata: {},
        expiresAt: Date.now() + 3_600_000,
        ...overrides,
    }
}

const engine = new ChannelRuleEngine()

// Channel name validation
describe('channel name validation', () => {
    const user = makeUser()

    test('allows valid names', () => {
        expect(engine.check('orders', user).allowed).toBe(true)
        expect(engine.check('order_updates', user).allowed).toBe(true)
        expect(engine.check('_internal', user).allowed).toBe(true)
        expect(engine.check('abc123', user).allowed).toBe(true)
    })

    test('rejects names starting with a digit', () => {
        const r = engine.check('1orders', user)
        expect(r.allowed).toBe(false)
        if (!r.allowed) expect(r.status).toBe(403)
    })

    test('rejects names with hyphens', () => {
        const r = engine.check('order-updates', user)
        expect(r.allowed).toBe(false)
    })

    test('rejects empty string', () => {
        const r = engine.check('', user)
        expect(r.allowed).toBe(false)
    })
})

// user_ rule
describe('userChannelRule', () => {
    test('matches user_ prefix', () => {
        expect(userChannelRule.match('user_abc')).toBe(true)
        expect(userChannelRule.match('orders')).toBe(false)
    })

    test('allows the owner', () => {
        const user = makeUser({ id: 'abc' })
        expect(userChannelRule.authorize('user_abc', user).allowed).toBe(true)
    })

    test('denies another user', () => {
        const user = makeUser({ id: 'xyz' })
        const r = userChannelRule.authorize('user_abc', user)
        expect(r.allowed).toBe(false)
        if (!r.allowed) expect(r.status).toBe(403)
    })
})

// role_ rule 
describe('roleChannelRule', () => {
    test('matches role_ prefix', () => {
        expect(roleChannelRule.match('role_admin')).toBe(true)
        expect(roleChannelRule.match('orders')).toBe(false)
    })

    test('allows user with matching role', () => {
        const user = makeUser({ role: 'admin' })
        expect(roleChannelRule.authorize('role_admin', user).allowed).toBe(true)
    })

    test('denies user with wrong role', () => {
        const user = makeUser({ role: 'authenticated' })
        const r = roleChannelRule.authorize('role_admin', user)
        expect(r.allowed).toBe(false)
        if (!r.allowed) expect(r.status).toBe(403)
    })
})

// org_ rule
describe('orgChannelRule', () => {
    test('matches org_ prefix', () => {
        expect(orgChannelRule.match('org_acme')).toBe(true)
        expect(orgChannelRule.match('orders')).toBe(false)
    })

    test('allows user in the org', () => {
        const user = makeUser({ appMetadata: { org_id: 'acme' } })
        expect(orgChannelRule.authorize('org_acme', user).allowed).toBe(true)
    })

    test('denies user in a different org', () => {
        const user = makeUser({ appMetadata: { org_id: 'other' } })
        const r = orgChannelRule.authorize('org_acme', user)
        expect(r.allowed).toBe(false)
        if (!r.allowed) expect(r.status).toBe(403)
    })
})

// private_ rule
describe('privateChannelRule', () => {
    test('matches private_ prefix', () => {
        expect(privateChannelRule.match('private_orders')).toBe(true)
        expect(privateChannelRule.match('orders')).toBe(false)
    })

    test('allows authenticated users', () => {
        const user = makeUser({ role: 'authenticated' })
        expect(privateChannelRule.authorize('private_orders', user).allowed).toBe(true)
    })

    test('allows service_role', () => {
        const user = makeUser({ role: 'service_role' })
        expect(privateChannelRule.authorize('private_orders', user).allowed).toBe(true)
    })

    test('denies anon users', () => {
        const user = makeUser({ role: 'anon' })
        const r = privateChannelRule.authorize('private_orders', user)
        expect(r.allowed).toBe(false)
        if (!r.allowed) expect(r.status).toBe(403)
    })
})

// public fallback rule
describe('publicChannelRule', () => {
    test('matches everything', () => {
        expect(publicChannelRule.match('anything')).toBe(true)
    })

    test('allows any user including anon', () => {
        expect(publicChannelRule.authorize('orders', makeUser({ role: 'anon' })).allowed).toBe(true)
    })
})

// ChannelRuleEngine.checkAll
describe('ChannelRuleEngine.checkAll', () => {
    test('returns null when all channels pass', () => {
        const user = makeUser({ id: 'abc', role: 'admin', appMetadata: { org_id: 'acme' } })
        expect(
            engine.checkAll(['orders', 'user_abc', 'role_admin', 'org_acme', 'private_data'], user)
        ).toBeNull()
    })

    test('returns the first failing channel', () => {
        const user = makeUser({ id: 'abc' })
        const denial = engine.checkAll(['orders', 'user_xyz', 'role_admin'], user)
        expect(denial).not.toBeNull()
        expect(denial?.channel).toBe('user_xyz')
    })
})


describe('custom rule engine', () => {
    test('custom rule takes precedence when prepended', () => {
        const blockAll = {
            name: 'block-all',
            match: () => true,
            authorize: () => ({ allowed: false, reason: 'blocked', status: 403 as const }),
        }
        const customEngine = new ChannelRuleEngine([blockAll, ...defaultRules()])
        const user = makeUser()
        expect(customEngine.check('orders', user).allowed).toBe(false)
    })
})
