import {
    ChannelRuleEngine,
    defaultRules,
    publicChannelRule,
    type ChannelRule,
} from './rules.ts'
import type { AuthUser } from '../types.ts'

// Channel configuration
//
// This is the ONE file you edit to control which channels exist and who can
// subscribe to them.
//
// Rules are evaluated top-to-bottom; the first rule whose `match()` returns
// true provides the final allow/deny decision for that channel.
//
// The bottom of this file shows a set of examples you can uncomment and adapt.

// Helper: deny-by-default fallback─
//
// Replace `publicChannelRule` at the end of your rules array with this when
// you want an explicit allowlist — any channel not matched above is rejected.
//
export const denyUnlistedChannels: ChannelRule = {
    name: 'deny-unlisted',
    match: () => true, // catches everything that fell through
    authorize: (channel) => ({
        allowed: false,
        reason: `Channel "${channel}" is not configured on this server`,
        status: 403,
    }),
}

/**
 * Allow exactly one named channel for everyone (public broadcast).
 *
 * @example  exactChannel('global')
 */
export function exactChannel(name: string): ChannelRule {
    return {
        name: `exact:${name}`,
        match: (channel) => channel === name,
        authorize: () => ({ allowed: true }),
    }
}

/**
 * Allow a named channel only to users with a specific role.
 *
 * @example  channelForRole('admin_events', 'admin')
 */
export function channelForRole(channelName: string, requiredRole: string): ChannelRule {
    return {
        name: `exact:${channelName}:role=${requiredRole}`,
        match: (channel) => channel === channelName,
        authorize: (_channel, user: AuthUser) =>
            user.role === requiredRole
                ? { allowed: true }
                : {
                    allowed: false,
                    reason: `Channel "${channelName}" requires role "${requiredRole}"`,
                    status: 403,
                },
    }
}

/**
 * Allow a named channel only to users whose `app_metadata` contains a
 * specific key/value pair.
 *
 * @example  channelForMetadata('beta_feed', 'beta', true)
 */
export function channelForMetadata(
    channelName: string,
    metaKey: string,
    metaValue: unknown
): ChannelRule {
    return {
        name: `exact:${channelName}:meta=${metaKey}`,
        match: (channel) => channel === channelName,
        authorize: (_channel, user: AuthUser) =>
            user.appMetadata[metaKey] === metaValue
                ? { allowed: true }
                : {
                    allowed: false,
                    reason: `Channel "${channelName}" requires ${metaKey}=${JSON.stringify(metaValue)}`,
                    status: 403,
                },
    }
}

// YOUR APP'S CHANNEL RULES
// Edit the array below. Remove examples you don't need.
export const ruleEngine = new ChannelRuleEngine([
    // Example 1: named public broadcast channels
    // Any authenticated user can subscribe; no prefix convention needed.
    exactChannel('announcements'),
    exactChannel('global'),
    exactChannel('status'),

    // Example 2: role-gated named channel
    // Only users with role "admin" can subscribe to "admin_events".
    channelForRole('admin_events', 'admin'),

    // Example 3: feature-flag channel 
    // Only users with app_metadata.beta === true can subscribe.
    channelForMetadata('beta_features', 'beta', true),

    // Example 4: plan-gated channel
    // Only users on the "pro" plan can subscribe.
    channelForMetadata('pro_feed', 'plan', 'pro'),

    // All the built-in prefix rules
    // user_{uuid}   -> owner only
    // role_{name}   -> JWT role must match
    // org_{id}      -> app_metadata.org_id must match
    // private_*     -> any authenticated (non-anon) user
    ...defaultRules().filter((r) => r.name !== 'public'), // strip the public fallback

    publicChannelRule,

    // OPTION B — deny any channel not matched above (strict allowlist):
    // Replace the line above with:
    // denyUnlistedChannels,
])
