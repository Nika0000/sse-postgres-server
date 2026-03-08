import type { AuthUser } from '../types.ts'

export type ChannelRuleResult =
    | { allowed: true }
    | { allowed: false; reason: string; status: 400 | 401 | 403 }

export type ChannelRule = {
    /**
     * Human-readable name used in logs and error messages.
     */
    readonly name: string

    /**
     * Returns true when this rule applies to the given channel.
     * Rules are evaluated in declaration order; first match wins.
     */
    match(channel: string): boolean

    /**
     * Returns whether the authenticated user may subscribe.
     * Only called when `match` returns true.
     */
    authorize(channel: string, user: AuthUser): ChannelRuleResult
}

export const CHANNEL_RE = /^[a-zA-Z_][a-zA-Z0-9_\-:]*(:\*)?$/

/**
 * Returns true when `channel` is a wildcard subscription pattern (`foo:*`).
 * Wildcards subscribe to the base Postgres channel (`foo`) and receive all
 * notifications on it regardless of their payload `event` field.
 */
export function isWildcard(channel: string): boolean {
    return channel.endsWith(':*')
}

/**
 * Strip the trailing `:*` wildcard suffix, returning the concrete Postgres
 * channel name that should be LISTENed on.
 *
 * @example resolveChannel('user_abc:*')     // -> 'user_abc'
 * @example resolveChannel('user_abc:orders') // -> 'user_abc:orders'
 * @example resolveChannel('global')          // -> 'global'
 */
export function resolveChannel(channel: string): string {
    return isWildcard(channel) ? channel.slice(0, -2) : channel
}


/**
 * `user_{uuid}` or `user_{uuid}:{subchannel}` — only the user whose UUID
 * appears in the channel name may subscribe.  The optional subchannel suffix
 * (after the first `:`) lets one user have multiple scoped feeds without
 * needing separate rule entries.
 *
 * @example  user_a1b2c3d4-0000-0000-0000-000000000000
 * @example  user_a1b2c3d4-0000-0000-0000-000000000000:session
 * @example  user_a1b2c3d4-0000-0000-0000-000000000000:payments
 * @example  user_a1b2c3d4-0000-0000-0000-000000000000:orders
 */
export const userChannelRule: ChannelRule = {
    name: 'user-private',
    match: (channel) => channel.startsWith('user_'),
    authorize(channel, user) {
        // Strip optional :subchannel suffix before comparing
        const withoutSub = channel.slice('user_'.length).split(':')[0]
        if (user.id === withoutSub) return { allowed: true }
        return {
            allowed: false,
            reason: `Channel "${channel}" is private — only the owner may subscribe`,
            status: 403,
        }
    },
}

/**
 * `role_{roleName}` — restrict a channel to users whose JWT `role` claim
 * matches the suffix.
 *
 * @example  role_admin        -> requires role "admin"
 * @example  role_service_role -> requires role "service_role"
 */
export const roleChannelRule: ChannelRule = {
    name: 'role-gated',
    match: (channel) => channel.startsWith('role_'),
    authorize(channel, user) {
        const required = channel.slice('role_'.length)
        if (user.role === required) return { allowed: true }
        return {
            allowed: false,
            reason: `Channel "${channel}" requires role "${required}"`,
            status: 403,
        }
    },
}

/**
 * `private_*` — blocks anonymous users (role = "anon") from subscribing.
 * Any authenticated user (role = "authenticated" or higher) is allowed.
 *
 * @example  private_orders -> rejects anon clients
 */
export const privateChannelRule: ChannelRule = {
    name: 'private',
    match: (channel) => channel.startsWith('private_'),
    authorize(_channel, user) {
        if (user.role !== 'anon') return { allowed: true }
        return {
            allowed: false,
            reason: 'Anonymous users may not subscribe to private channels',
            status: 403,
        }
    },
}

/**
 * `org_{orgId}` — multi-tenant channel scoped to an organisation.  The user
 * must have `app_metadata.org_id` set to the matching value.
 *
 * @example  org_acme -> requires app_metadata.org_id === "acme"
 */
export const orgChannelRule: ChannelRule = {
    name: 'org-scoped',
    match: (channel) => channel.startsWith('org_'),
    authorize(channel, user) {
        const orgId = channel.slice('org_'.length)
        if (user.appMetadata.org_id === orgId) return { allowed: true }
        return {
            allowed: false,
            reason: `Channel "${channel}" is scoped to organisation "${orgId}"`,
            status: 403,
        }
    },
}

/**
 * Catch-all fallback — any authenticated user (including "anon") may
 * subscribe to public channels.  This rule always matches.
 */
export const publicChannelRule: ChannelRule = {
    name: 'public',
    match: () => true,
    authorize: () => ({ allowed: true }),
}

/**
 * Evaluates an ordered list of channel rules against a user.
 *
 * Rules are checked in order; the first one whose `match()` returns true
 * provides the authorisation decision.  If no rule matches the built-in
 * `publicChannelRule` fallback allows the subscription.
 *
 * Custom rules can be prepended to override the defaults:
 *
 * ```ts
 * const engine = new ChannelRuleEngine([myCustomRule, ...defaultRules()])
 * ```
 */
export class ChannelRuleEngine {
    constructor(private readonly rules: readonly ChannelRule[] = defaultRules()) { }

    /**
     * Validate the channel name format and check authorisation.
     * Wildcard channels (`foo:*`) are resolved to their base channel before
     * both validation and rule matching.
     */
    check(channel: string, user: AuthUser): ChannelRuleResult {
        const resolved = resolveChannel(channel)
        if (!CHANNEL_RE.test(channel)) {
            return {
                allowed: false,
                reason: `Invalid channel name "${channel}" — only letters, digits and underscores allowed, must start with a letter or underscore`,
                status: 403,
            }
        }

        for (const rule of this.rules) {
            if (rule.match(resolved)) {
                return rule.authorize(resolved, user)
            }
        }

        // Unreachable as long as rules includes publicChannelRule, but be safe.
        return { allowed: true }
    }

    /**
     * Check all channels in one pass.  Returns the first denial, or null when
     * every channel is allowed.
     */
    checkAll(
        channels: readonly string[],
        user: AuthUser
    ): { channel: string; result: Extract<ChannelRuleResult, { allowed: false }> } | null {
        for (const channel of channels) {
            const result = this.check(channel, user)
            if (!result.allowed) return { channel, result }
        }
        return null
    }
}

/**
 * Returns the default ordered set of built-in channel rules.
 *
 * Order matters — more specific prefixes must come before the public fallback.
 */
export function defaultRules(): ChannelRule[] {
    return [userChannelRule, roleChannelRule, orgChannelRule, privateChannelRule, publicChannelRule]
}
