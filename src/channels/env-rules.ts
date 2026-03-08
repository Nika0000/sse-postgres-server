/**
 * src/channels/env-rules.ts
 *
 * Parses the CHANNEL_RULES environment variable into a ChannelRuleEngine.
 *
 * This lets you configure channel access entirely from docker-compose /
 * Kubernetes env vars without rebuilding the image.
 *
 * JSON schema 
 *
 * CHANNEL_RULES is a JSON array of rule descriptors evaluated top-to-bottom.
 * The first matching rule wins.
 *
 * Built-in prefix rules (map to the same rules as the programmatic API):
 *
 *   { "type": "user_prefix"    }   ->  user_{uuid}      owner-only
 *   { "type": "role_prefix"    }   ->  role_{name}      JWT role must match
 *   { "type": "org_prefix"     }   ->  org_{id}         app_metadata.org_id
 *   { "type": "private_prefix" }   ->  private_*        any non-anon user
 *   { "type": "public"         }   ->  catch-all allow  (open)
 *   { "type": "deny_unlisted"  }   ->  catch-all deny   (strict allowlist)
 *
 * Named-channel rules:
 *
 *   { "type": "exact",     "channel": "announcements"                   }  allow all authenticated users
 *   { "type": "role_gate", "channel": "admin_feed",  "role": "admin"   }  require JWT role
 *   { "type": "meta_gate", "channel": "beta_feed",   "key": "beta",    "value": true }  require app_metadata.key === value
 *
 * Prefix rules (custom):
 *
 *   { "type": "team_prefix"  }  ->  team_{id}   app_metadata.team_id
 *   { "type": "plan_prefix"  }  ->  plan_{tier} tiered subscription gate
 *
 * Generic prefix+metadata rule:
 *
 *   { "type": "prefix_meta", "prefix": "lobby_", "key": "lobby_id" }
 *       -> channel must start with "lobby_"; app_metadata.lobby_id must equal the suffix
 *   { "type": "prefix_meta", "prefix": "session_", "key": "session_id" }
 *       -> channel must start with "session_"; app_metadata.session_id must equal the suffix
 *
 * Example
 *
 *   CHANNEL_RULES='[
 *     { "type": "exact",     "channel": "announcements" },
 *     { "type": "exact",     "channel": "global"        },
 *     { "type": "role_gate", "channel": "admin_events", "role": "admin" },
 *     { "type": "meta_gate", "channel": "beta_feed",    "key": "beta", "value": true },
 *     { "type": "team_prefix" },
 *     { "type": "plan_prefix" },
 *     { "type": "prefix_meta", "prefix": "lobby_", "key": "lobby_id" },
 *     { "type": "user_prefix" },
 *     { "type": "role_prefix" },
 *     { "type": "org_prefix"  },
 *     { "type": "private_prefix" },
 *     { "type": "deny_unlisted" }
 *   ]'
 */

import {
    ChannelRuleEngine,
    userChannelRule,
    roleChannelRule,
    orgChannelRule,
    privateChannelRule,
    publicChannelRule,
    type ChannelRule,
} from './rules.ts'
import { teamChannelRule, planChannelRule } from './examples.ts'
import { denyUnlistedChannels, exactChannel, channelForRole, channelForMetadata } from './helpers.ts'

type ExactDescriptor = { type: 'exact'; channel: string }
type RoleGateDescriptor = { type: 'role_gate'; channel: string; role: string }
type MetaGateDescriptor = { type: 'meta_gate'; channel: string; key: string; value: unknown }
type PrefixMetaDescriptor = { type: 'prefix_meta'; prefix: string; key: string }
type BuiltinDescriptor = {
    type:
    | 'user_prefix'
    | 'role_prefix'
    | 'org_prefix'
    | 'private_prefix'
    | 'public'
    | 'deny_unlisted'
    | 'team_prefix'
    | 'plan_prefix'
}

export type RuleDescriptor =
    | ExactDescriptor
    | RoleGateDescriptor
    | MetaGateDescriptor
    | PrefixMetaDescriptor
    | BuiltinDescriptor

/**
 * A resolver for custom rule descriptors.
 *
 * Return a `ChannelRule` when your resolver recognises the descriptor,
 * or `null` to let the built-in resolver handle it.
 *
 * @example
 * const myResolver: CustomRuleResolver = (d) => {
 *   if (d.type !== 'session_prefix') return null
 *   return {
 *     name: 'session_',
 *     match: (ch) => ch.startsWith('session_'),
 *     authorize: (_ch, user) =>
 *       user.appMetadata.session_id != null
 *         ? { allowed: true }
 *         : { allowed: false, reason: 'No active session', status: 403 },
 *   }
 * }
 * const engine = parseEnvRules(process.env.CHANNEL_RULES!, [myResolver])
 */
export type CustomRuleResolver = (
    descriptor: Record<string, unknown>
) => ChannelRule | null

// Descriptor -> ChannelRule
function descriptorToRule(
    d: RuleDescriptor,
    customResolvers: readonly CustomRuleResolver[] = []
): ChannelRule {
    switch (d.type) {
        case 'exact':
            return exactChannel(d.channel)

        case 'role_gate':
            return channelForRole(d.channel, d.role)

        case 'meta_gate':
            return channelForMetadata(d.channel, d.key, d.value)

        case 'prefix_meta': {
            const { prefix, key } = d
            return {
                name: `prefix_meta:${prefix}${key}`,
                match: (ch) => ch.startsWith(prefix),
                authorize: (ch, user) => {
                    const id = ch.slice(prefix.length)
                    if (!id)
                        return { allowed: false, reason: `${prefix} channel must include an ID`, status: 400 }
                    return String(user.appMetadata[key]) === id
                        ? { allowed: true }
                        : { allowed: false, reason: `app_metadata.${key} does not match "${id}"`, status: 403 }
                },
            }
        }

        case 'user_prefix':
            return userChannelRule
        case 'role_prefix':
            return roleChannelRule
        case 'org_prefix':
            return orgChannelRule
        case 'private_prefix':
            return privateChannelRule
        case 'public':
            return publicChannelRule
        case 'deny_unlisted':
            return denyUnlistedChannels

        case 'team_prefix':
            return teamChannelRule
        case 'plan_prefix':
            return planChannelRule

        default: {
            // Try each custom resolver before giving up.
            const raw = d as Record<string, unknown>
            for (const resolve of customResolvers) {
                const rule = resolve(raw)
                if (rule) return rule
            }
            throw new Error(`Unknown rule type: ${JSON.stringify(d)}`)
        }
    }
}

const VALID_TYPES = new Set([
    'exact',
    'role_gate',
    'meta_gate',
    'prefix_meta',
    'user_prefix',
    'role_prefix',
    'org_prefix',
    'private_prefix',
    'public',
    'deny_unlisted',
    'team_prefix',
    'plan_prefix',
])

function validate(
    raw: unknown,
    customResolvers: readonly CustomRuleResolver[] = []
): RuleDescriptor[] {
    if (!Array.isArray(raw)) {
        throw new Error('CHANNEL_RULES must be a JSON array')
    }
    return raw.map((item: unknown, i: number) => {
        if (typeof item !== 'object' || item === null) {
            throw new Error(`CHANNEL_RULES[${i}]: expected an object, got ${JSON.stringify(item)}`)
        }
        const obj = item as Record<string, unknown>
        const isBuiltin = typeof obj.type === 'string' && VALID_TYPES.has(obj.type)
        const isCustom = !isBuiltin && customResolvers.some((r) => r(obj) !== null)
        if (typeof obj.type !== 'string' || (!isBuiltin && !isCustom)) {
            throw new Error(
                `CHANNEL_RULES[${i}]: unknown type "${obj.type}". Valid types: ${[...VALID_TYPES].join(', ')}${customResolvers.length ? ' (plus any registered custom types)' : ''
                }`
            )
        }
        if ((obj.type === 'exact' || obj.type === 'role_gate' || obj.type === 'meta_gate') && typeof obj.channel !== 'string') {
            throw new Error(`CHANNEL_RULES[${i}] (${obj.type}): "channel" must be a string`)
        }
        if (obj.type === 'role_gate' && typeof obj.role !== 'string') {
            throw new Error(`CHANNEL_RULES[${i}] (role_gate): "role" must be a string`)
        }
        if (obj.type === 'meta_gate' && typeof obj.key !== 'string') {
            throw new Error(`CHANNEL_RULES[${i}] (meta_gate): "key" must be a string`)
        }
        if (obj.type === 'meta_gate' && !('value' in obj)) {
            throw new Error(`CHANNEL_RULES[${i}] (meta_gate): "value" is required`)
        }
        if (obj.type === 'prefix_meta' && typeof obj.prefix !== 'string') {
            throw new Error(`CHANNEL_RULES[${i}] (prefix_meta): "prefix" must be a string`)
        }
        if (obj.type === 'prefix_meta' && typeof obj.key !== 'string') {
            throw new Error(`CHANNEL_RULES[${i}] (prefix_meta): "key" must be a string`)
        }
        return obj as unknown as RuleDescriptor
    })
}

/**
 * Parse a CHANNEL_RULES JSON string and return a ChannelRuleEngine.
 *
 * Pass `customResolvers` to support descriptor types beyond the built-ins
 * without modifying this file.
 *
 * @example
 * const engine = parseEnvRules(json, [
 *   (d) => d.type === 'session_prefix' ? sessionChannelRule : null,
 * ])
 */
export function parseEnvRules(
    json: string,
    customResolvers: readonly CustomRuleResolver[] = []
): ChannelRuleEngine {
    let raw: unknown
    try {
        raw = JSON.parse(json)
    } catch {
        throw new Error(`CHANNEL_RULES contains invalid JSON: ${json.slice(0, 120)}`)
    }
    const descriptors = validate(raw, customResolvers)
    const rules = descriptors.map((d) => descriptorToRule(d, customResolvers))
    return new ChannelRuleEngine(rules)
}

/**
 * Returns a ChannelRuleEngine built from the CHANNEL_RULES env var, or null
 * if the variable is not set.
 *
 * Pass `customResolvers` to handle descriptor types not built into this file.
 */
export function engineFromEnv(
    customResolvers: readonly CustomRuleResolver[] = []
): ChannelRuleEngine | null {
    const raw = process.env.CHANNEL_RULES
    if (!raw) return null
    return parseEnvRules(raw, customResolvers)
}
