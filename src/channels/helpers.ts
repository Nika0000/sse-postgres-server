/**
 * src/channels/helpers.ts
 *
 * Small factory functions for building named-channel rules.
 * Imported by both config.ts (programmatic setup) and env-rules.ts (JSON setup).
 */

import type { AuthUser } from '../types.ts'
import { type ChannelRule } from './rules.ts'

/**
 * Catch-all deny rule — any channel not matched by a rule above is rejected.
 * Use as the last entry in your rules array for a strict allowlist.
 */
export const denyUnlistedChannels: ChannelRule = {
    name: 'deny-unlisted',
    match: () => true,
    authorize: (channel) => ({
        allowed: false,
        reason: `Channel "${channel}" is not configured on this server`,
        status: 403,
    }),
}

/**
 * Allow exactly one named channel for any authenticated user.
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
 * Allow a named channel only to users with a specific JWT role.
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
 * Allow a named channel only to users whose `app_metadata` contains a key/value.
 *
 * @example  channelForMetadata('beta_feed', 'beta', true)
 * @example  channelForMetadata('pro_feed',  'plan', 'pro')
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
