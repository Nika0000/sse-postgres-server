/**
 * src/channels/examples.ts
 *
 * Ready-to-copy rule recipes for common real-world scenarios.
 * None of these are wired in by default — copy what you need into config.ts.
 *
 * Each recipe includes:
 *  - a ChannelRule object you can drop straight into the rules array
 *  - a comment explaining the expected JWT shape
 *  - an example channel name that would match
 */

import { ChannelRuleEngine, defaultRules, type ChannelRule } from './rules.ts'
import type { AuthUser } from '../types.ts'

// Recipe 1: Explicit Allow-List
//
// Only channels named in a hard-coded set are permitted.
// Any channel not in the set is rejected with 403.
//
// Usage: replace the catch-all at the bottom of config.ts with this rule.
export function allowListRule(permitted: Set<string>): ChannelRule {
    return {
        name: 'allowlist',
        match: () => true, // run on every channel
        authorize: (channel) =>
            permitted.has(channel)
                ? { allowed: true }
                : {
                    allowed: false,
                    reason: `Channel "${channel}" is not on the allowlist`,
                    status: 403,
                },
    }
}

// Recipe 2: Deny-List (block specific channels)
//
// Useful to block channels that should exist in principle but are
// temporarily disabled or reserved for internal use.
//
// Place this rule BEFORE the prefix rules so it short-circuits early.
export function denyListRule(blocked: Set<string>): ChannelRule {
    return {
        name: 'denylist',
        match: (channel) => blocked.has(channel),
        authorize: (channel) => ({
            allowed: false,
            reason: `Channel "${channel}" is currently unavailable`,
            status: 403,
        }),
    }
}

// Recipe 3: team_{id} prefix
//
// Channel:  team_42
// JWT claim: app_metadata.team_id === "42"
//
// Allows a user to subscribe only to the channel for their own team.
export const teamChannelRule: ChannelRule = {
    name: 'team_',
    match: (channel) => channel.startsWith('team_'),
    authorize: (channel, user: AuthUser) => {
        const teamId = channel.slice('team_'.length)
        if (!teamId)
            return { allowed: false, reason: 'team_ channel must include a team ID', status: 400 }
        return String(user.appMetadata.team_id) === teamId
            ? { allowed: true }
            : {
                allowed: false,
                reason: `User is not a member of team "${teamId}"`,
                status: 403,
            }
    },
}

// Recipe 4: plan_{tier} prefix  (subscription-gating)
//
// Channel:  plan_pro, plan_enterprise
// JWT claim: app_metadata.plan === "pro" | "enterprise" | …
//
// E.g. "plan_pro" requires app_metadata.plan === "pro" or higher.
const PLAN_RANK: Record<string, number> = { free: 0, starter: 1, pro: 2, enterprise: 3 }

export const planChannelRule: ChannelRule = {
    name: 'plan_',
    match: (channel) => channel.startsWith('plan_'),
    authorize: (channel, user: AuthUser) => {
        const required = channel.slice('plan_'.length)
        const requiredRank = PLAN_RANK[required]
        if (requiredRank === undefined)
            return { allowed: false, reason: `Unknown plan tier "${required}"`, status: 400 }

        const userPlan = String(user.appMetadata.plan ?? 'free')
        const userRank = PLAN_RANK[userPlan] ?? 0
        return userRank >= requiredRank
            ? { allowed: true }
            : {
                allowed: false,
                reason: `Channel "${channel}" requires plan "${required}" or higher`,
                status: 403,
            }
    },
}

// Recipe 5: Email-verified gate
//
// Wraps any rule so only email-confirmed users pass through.
// JWT claim: app_metadata.email_confirmed === true
//
// Usage: wrap another rule or slot above the catch-all.
export function requireEmailVerified(inner: ChannelRule): ChannelRule {
    return {
        name: `${inner.name}+email_verified`,
        match: inner.match.bind(inner),
        authorize: (channel, user: AuthUser) => {
            if (!user.appMetadata.email_confirmed)
                return { allowed: false, reason: 'Email address is not verified', status: 403 }
            return inner.authorize(channel, user)
        },
    }
}

// Recipe 6: Audit-logging wrapper
//
// Wraps any rule and logs every subscription attempt.
// Useful during rollout of a new rule to audit before enforcing.
export function withAuditLog(
    inner: ChannelRule,
    log: (msg: string, meta: object) => void = console.log.bind(console)
): ChannelRule {
    return {
        name: `${inner.name}+audit`,
        match: inner.match.bind(inner),
        authorize: (channel, user: AuthUser) => {
            const result = inner.authorize(channel, user)
            log(`channel_subscribe_attempt`, {
                channel,
                userId: user.id,
                role: user.role,
                allowed: result.allowed,
                reason: result.allowed ? undefined : (result as { reason: string }).reason,
            })
            return result
        },
    }
}

// Recipe 7: Time-windowed channel
//
// Block a channel outside a configured UTC time window.
// Useful for maintenance windows or scheduled availability.
export function timeWindowRule(
    channelName: string,
    /** UTC hours [startHour, endHour)  e.g. [8, 18] = 08:00–17:59 UTC */
    utcRange: [number, number]
): ChannelRule {
    const [start, end] = utcRange
    return {
        name: `time-window:${channelName}`,
        match: (channel) => channel === channelName,
        authorize: () => {
            const hour = new Date().getUTCHours()
            return hour >= start && hour < end
                ? { allowed: true }
                : {
                    allowed: false,
                    reason: `Channel "${channelName}" is only available between ${start}:00 and ${end}:00 UTC`,
                    status: 403,
                }
        },
    }
}

// Recipe 8: Composite engine: per-environment rules
//
// Build different engines for different environments without changing rule
// logic — just compose them at startup.
export function buildEngine(env: 'development' | 'staging' | 'production'): ChannelRuleEngine {
    const base: ChannelRule[] = [teamChannelRule, planChannelRule, ...defaultRules()]

    if (env === 'development') {
        // In dev, allow all channels without restriction for easy testing.
        return new ChannelRuleEngine(base)
    }

    if (env === 'staging') {
        // In staging, require email verification everywhere.
        const [, ...rest] = base // drop first rule temporarily if needed
        void rest
        return new ChannelRuleEngine(base.map((r) => requireEmailVerified(r)))
    }

    // Production: strict allowlist + audit logging on everything
    const audited = base.map((r) => withAuditLog(r))
    return new ChannelRuleEngine(audited)
}
