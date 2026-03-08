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
 * Example
 *
 *   CHANNEL_RULES='[
 *     { "type": "exact",     "channel": "announcements" },
 *     { "type": "exact",     "channel": "global"        },
 *     { "type": "role_gate", "channel": "admin_events", "role": "admin" },
 *     { "type": "meta_gate", "channel": "beta_feed",    "key": "beta", "value": true },
 *     { "type": "team_prefix" },
 *     { "type": "plan_prefix" },
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
    | BuiltinDescriptor

// Descriptor -> ChannelRule
function descriptorToRule(d: RuleDescriptor): ChannelRule {
    switch (d.type) {
        case 'exact':
            return exactChannel(d.channel)

        case 'role_gate':
            return channelForRole(d.channel, d.role)

        case 'meta_gate':
            return channelForMetadata(d.channel, d.key, d.value)

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
            const _exhaustive: never = d
            throw new Error(`Unknown rule type: ${JSON.stringify(_exhaustive)}`)
        }
    }
}

const VALID_TYPES = new Set([
    'exact',
    'role_gate',
    'meta_gate',
    'user_prefix',
    'role_prefix',
    'org_prefix',
    'private_prefix',
    'public',
    'deny_unlisted',
    'team_prefix',
    'plan_prefix',
])

function validate(raw: unknown): RuleDescriptor[] {
    if (!Array.isArray(raw)) {
        throw new Error('CHANNEL_RULES must be a JSON array')
    }
    return raw.map((item: unknown, i: number) => {
        if (typeof item !== 'object' || item === null) {
            throw new Error(`CHANNEL_RULES[${i}]: expected an object, got ${JSON.stringify(item)}`)
        }
        const obj = item as Record<string, unknown>
        if (typeof obj.type !== 'string' || !VALID_TYPES.has(obj.type)) {
            throw new Error(
                `CHANNEL_RULES[${i}]: unknown type "${obj.type}". Valid types: ${[...VALID_TYPES].join(', ')}`
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
        return obj as unknown as RuleDescriptor
    })
}

/**
 * Parse the CHANNEL_RULES environment variable and return a ChannelRuleEngine.
 * Throws with a descriptive message if the JSON is invalid.
 */
export function parseEnvRules(json: string): ChannelRuleEngine {
    let raw: unknown
    try {
        raw = JSON.parse(json)
    } catch {
        throw new Error(`CHANNEL_RULES contains invalid JSON: ${json.slice(0, 120)}`)
    }
    const descriptors = validate(raw)
    const rules = descriptors.map(descriptorToRule)
    return new ChannelRuleEngine(rules)
}

/**
 * Returns a ChannelRuleEngine built from CHANNEL_RULES env var, or null if
 * the variable is not set.
 */
export function engineFromEnv(): ChannelRuleEngine | null {
    const raw = process.env.CHANNEL_RULES
    if (!raw) return null
    return parseEnvRules(raw)
}
