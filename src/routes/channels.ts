/**
 * PATCH /events/channels
 *
 * Dynamically add or remove channel subscriptions on an **existing** SSE
 * connection without closing the stream or reconnecting.
 *
 * Request body (JSON):
 *   {
 *     "clientId": "<id returned in the `connected` event>",
 *     "add":    ["channel_a", "channel_b"],   // optional
 *     "remove": ["channel_c"]                 // optional
 *   }
 *
 * Response 200:
 *   { "channels": ["...all current channels after the update..."] }
 *
 * The SSE stream also receives an in-band `channels_updated` event so the
 * client can react without polling.
 *
 * Auth: same Bearer JWT (or ?token= query param) as /events.
 *       The JWT's sub must own the clientId.
 */

import type { Config } from '../config.ts'
import { verifyJwt, extractToken } from '../auth.ts'
import type { ChannelRuleEngine } from '../channels/rules.ts'
import { resolveChannel } from '../channels/rules.ts'
import { clientsById, addClientChannel, removeClientChannel } from '../channels/registry.ts'
import { listenChannel, unlistenChannel, jsonLine, makeDeadClientHandler } from '../channels/db.ts'
import { logger } from '../logger.ts'
import type { ChannelsUpdatedPayload } from '../types.ts'

export async function handleChannelUpdate(
    request: Request,
    url: URL,
    cors: Record<string, string>,
    config: Config,
    engine: ChannelRuleEngine
): Promise<Response> {
    const token = extractToken(request, url)
    if (!token) {
        return new Response('Unauthorized — provide a JWT via Authorization header or ?token=', {
            status: 401,
            headers: cors,
        })
    }
    const user = await verifyJwt(token, config)
    if (!user) {
        return new Response('Invalid or expired token', { status: 403, headers: cors })
    }

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return new Response('Invalid JSON body', { status: 400, headers: cors })
    }

    const raw = body as Record<string, unknown>
    const clientId = raw.clientId
    if (typeof clientId !== 'string' || !clientId) {
        return new Response('"clientId" is required', { status: 400, headers: cors })
    }

    const rawAdd = Array.isArray(raw.add) ? (raw.add as unknown[]) : []
    const rawRemove = Array.isArray(raw.remove) ? (raw.remove as unknown[]) : []

    if (rawAdd.length === 0 && rawRemove.length === 0) {
        return new Response('"add" or "remove" must be non-empty', { status: 400, headers: cors })
    }

    const addList = rawAdd.filter((c) => typeof c === 'string') as string[]
    const removeList = rawRemove.filter((c) => typeof c === 'string') as string[]

    const client = clientsById.get(clientId)
    if (!client) {
        return new Response('Client not found — it may have disconnected', { status: 404, headers: cors })
    }
    if (client.user.id !== user.id) {
        return new Response('Forbidden — this clientId belongs to a different user', {
            status: 403,
            headers: cors,
        })
    }

    if (addList.length > 0) {
        const denial = engine.checkAll(addList, user)
        if (denial) {
            return new Response(denial.result.reason, {
                status: denial.result.status,
                headers: cors,
            })
        }
    }

    // Resolve wildcards + skip channels already subscribed / already absent.
    const resolvedAdd = [...new Set(addList.map(resolveChannel))].filter(
        (ch) => !client.channels.has(ch)
    )
    const resolvedRemove = [...new Set(removeList.map(resolveChannel))].filter((ch) =>
        client.channels.has(ch)
    )

    for (const ch of resolvedAdd) {
        addClientChannel(client, ch)
    }

    const onDead = makeDeadClientHandler(config)
    try {
        await Promise.all(resolvedAdd.map((ch) => listenChannel(ch, config, onDead)))
    } catch (err) {
        // Roll back index changes for channels that didn't start listening.
        for (const ch of resolvedAdd) {
            await removeClientChannel(client, ch, (c) => unlistenChannel(c, config)).catch(() => { })
        }
        logger.error(err, '[channels_update] listen failed')
        return new Response('Failed to subscribe to one or more channels', {
            status: 500,
            headers: cors,
        })
    }

    for (const ch of resolvedRemove) {
        await removeClientChannel(client, ch, (c) => unlistenChannel(c, config))
    }

    const currentChannels = [...client.channels]
    client.send(
        jsonLine('channels_updated', {
            add: resolvedAdd,
            remove: resolvedRemove,
            channels: currentChannels,
        } satisfies ChannelsUpdatedPayload)
    )

    logger.info(
        { clientId, userId: user.id, add: resolvedAdd, remove: resolvedRemove },
        '[channels_update]'
    )

    return new Response(JSON.stringify({ channels: currentChannels }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
    })
}
