import { describe, test, expect, vi } from 'vitest'
import {
    allowListRule,
    denyListRule,
    teamChannelRule,
    planChannelRule,
    requireEmailVerified,
    withAuditLog,
} from '../channels/examples.ts'
import {
    denyUnlistedChannels,
    exactChannel,
    channelForRole,
    channelForMetadata,
} from '../channels/helpers.ts'
import {
    ChannelRuleEngine,
    defaultRules,
    publicChannelRule,
} from '../channels/rules.ts'
import type { AuthUser } from '../types.ts'

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'user-1',
        email: 'alice@example.com',
        role: 'authenticated',
        appMetadata: {},
        userMetadata: {},
        expiresAt: Date.now() + 3_600_000,
        ...overrides,
    }
}

// allowListRule 
describe('allowListRule', () => {
    const rule = allowListRule(new Set(['announcements', 'global']))
    const user = makeUser()

    test('allows a channel on the allowlist', () => {
        expect(rule.authorize('announcements', user).allowed).toBe(true)
        expect(rule.authorize('global', user).allowed).toBe(true)
    })

    test('denies a channel not on the allowlist', () => {
        const result = rule.authorize('other', user)
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
            expect(result.status).toBe(403)
            expect(result.reason).toMatch(/allowlist/)
        }
    })

    test('match() is true for every channel (catch-all)', () => {
        expect(rule.match('anything')).toBe(true)
    })
})

// denyListRule
describe('denyListRule', () => {
    const rule = denyListRule(new Set(['legacy_feed', 'internal_debug']))
    const user = makeUser()

    test('matches only blocked channels', () => {
        expect(rule.match('legacy_feed')).toBe(true)
        expect(rule.match('orders')).toBe(false)
    })

    test('denies a blocked channel', () => {
        const result = rule.authorize('legacy_feed', user)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(403)
    })
})

// teamChannelRule
describe('teamChannelRule', () => {
    test('matches team_ prefix', () => {
        expect(teamChannelRule.match('team_42')).toBe(true)
        expect(teamChannelRule.match('orders')).toBe(false)
    })

    test('allows user whose team_id matches', () => {
        const user = makeUser({ appMetadata: { team_id: 42 } })
        expect(teamChannelRule.authorize('team_42', user).allowed).toBe(true)
    })

    test('denies user from a different team', () => {
        const user = makeUser({ appMetadata: { team_id: 99 } })
        const result = teamChannelRule.authorize('team_42', user)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(403)
    })

    test('denies when team_id is missing', () => {
        const user = makeUser()
        expect(teamChannelRule.authorize('team_42', user).allowed).toBe(false)
    })

    test('rejects bare team_ with no id', () => {
        const user = makeUser({ appMetadata: { team_id: '' } })
        const result = teamChannelRule.authorize('team_', user)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(400)
    })
})

// planChannelRule
describe('planChannelRule', () => {
    test('matches plan_ prefix', () => {
        expect(planChannelRule.match('plan_pro')).toBe(true)
        expect(planChannelRule.match('announcements')).toBe(false)
    })

    test('allows user on exact required plan', () => {
        const user = makeUser({ appMetadata: { plan: 'pro' } })
        expect(planChannelRule.authorize('plan_pro', user).allowed).toBe(true)
    })

    test('allows user on higher plan (enterprise ≥ pro)', () => {
        const user = makeUser({ appMetadata: { plan: 'enterprise' } })
        expect(planChannelRule.authorize('plan_pro', user).allowed).toBe(true)
    })

    test('denies user on lower plan (starter < pro)', () => {
        const user = makeUser({ appMetadata: { plan: 'starter' } })
        const result = planChannelRule.authorize('plan_pro', user)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(403)
    })

    test('defaults to free tier when plan is missing', () => {
        const user = makeUser()
        const result = planChannelRule.authorize('plan_pro', user)
        expect(result.allowed).toBe(false)
    })

    test('rejects unknown tier name', () => {
        const user = makeUser({ appMetadata: { plan: 'enterprise' } })
        const result = planChannelRule.authorize('plan_ultimate', user)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(400)
    })
})

// requireEmailVerified
describe('requireEmailVerified', () => {
    const rule = requireEmailVerified(publicChannelRule)
    const user = makeUser()

    test('passes through to inner rule when email is confirmed', () => {
        const verified = makeUser({ appMetadata: { email_confirmed: true } })
        expect(rule.authorize('any_channel', verified).allowed).toBe(true)
    })

    test('denies when email_confirmed is false', () => {
        const unverified = makeUser({ appMetadata: { email_confirmed: false } })
        const result = rule.authorize('any_channel', unverified)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.reason).toMatch(/verified/)
    })

    test('denies when email_confirmed is missing', () => {
        expect(rule.authorize('any_channel', user).allowed).toBe(false)
    })

    test('inherits match() from inner rule', () => {
        expect(rule.match('whatever')).toBe(publicChannelRule.match('whatever'))
    })
})

// withAuditLog
describe('withAuditLog', () => {
    test('calls log on every authorization', () => {
        const logFn = vi.fn()
        const rule = withAuditLog(publicChannelRule, logFn)
        const user = makeUser()

        rule.authorize('orders', user)
        expect(logFn).toHaveBeenCalledOnce()
        const [event, meta] = logFn.mock.calls[0] as [string, Record<string, unknown>]
        expect(event).toBe('channel_subscribe_attempt')
        expect(meta.channel).toBe('orders')
        expect(meta.allowed).toBe(true)
    })

    test('logs denial reason on blocked channel', () => {
        const logFn = vi.fn()
        const denyAll = denyListRule(new Set(['blocked']))
        const rule = withAuditLog(denyAll, logFn)
        const user = makeUser()

        rule.authorize('blocked', user)
        const [, meta] = logFn.mock.calls[0] as [string, Record<string, unknown>]
        expect(meta.allowed).toBe(false)
        expect(typeof meta.reason).toBe('string')
    })
})

// denyUnlistedChannels
describe('denyUnlistedChannels', () => {
    const user = makeUser()

    test('matches everything (catch-all)', () => {
        expect(denyUnlistedChannels.match('anything')).toBe(true)
    })

    test('always denies with 403', () => {
        const result = denyUnlistedChannels.authorize('mystery_channel', user)
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
            expect(result.status).toBe(403)
            expect(result.reason).toMatch(/not configured/)
        }
    })
})

// exactChannel factory
describe('exactChannel', () => {
    const rule = exactChannel('status')
    const user = makeUser()

    test('matches only the exact name', () => {
        expect(rule.match('status')).toBe(true)
        expect(rule.match('status_updates')).toBe(false)
    })

    test('allows any authenticated user', () => {
        expect(rule.authorize('status', user).allowed).toBe(true)
    })
})

// channelForRole factory
describe('channelForRole', () => {
    const rule = channelForRole('admin_events', 'admin')
    const admin = makeUser({ role: 'admin' })
    const regular = makeUser({ role: 'authenticated' })

    test('matches the configured channel name', () => {
        expect(rule.match('admin_events')).toBe(true)
        expect(rule.match('orders')).toBe(false)
    })

    test('allows a user with the required role', () => {
        expect(rule.authorize('admin_events', admin).allowed).toBe(true)
    })

    test('denies a user without the required role', () => {
        const result = rule.authorize('admin_events', regular)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(403)
    })
})

// channelForMetadata factory
describe('channelForMetadata', () => {
    const rule = channelForMetadata('beta_features', 'beta', true)
    const betaUser = makeUser({ appMetadata: { beta: true } })
    const regularUser = makeUser()

    test('allows user with matching metadata', () => {
        expect(rule.authorize('beta_features', betaUser).allowed).toBe(true)
    })

    test('denies user without the metadata flag', () => {
        const result = rule.authorize('beta_features', regularUser)
        expect(result.allowed).toBe(false)
        if (!result.allowed) expect(result.status).toBe(403)
    })
})

// Integration: engine with custom + default rules
describe('engine composition with examples', () => {
    const engine = new ChannelRuleEngine([
        denyListRule(new Set(['blocked'])),
        teamChannelRule,
        planChannelRule,
        ...defaultRules(),
    ])

    test('blocked channel is denied before any other rule fires', () => {
        const user = makeUser()
        const result = engine.check('blocked', user)
        expect(result.allowed).toBe(false)
    })

    test('team channel resolved by teamChannelRule', () => {
        const user = makeUser({ appMetadata: { team_id: 7 } })
        expect(engine.check('team_7', user).allowed).toBe(true)
    })

    test('user_ channel still resolved by built-in rule', () => {
        const user = makeUser({ id: 'abc' })
        expect(engine.check('user_abc', user).allowed).toBe(true)
        expect(engine.check('user_other', user).allowed).toBe(false)
    })
})
