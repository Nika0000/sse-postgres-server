import type { Config } from '../config.ts'
import { verifyJwt, extractToken } from '../auth.ts'
import type { ChannelRuleEngine } from '../channels/rules.ts'
import {
    clientsById,
    connectionCountByUser,
    clientsByChannel,
    registerClient,
    unregisterClient,
    removeClient,
} from '../channels/registry.ts'
import {
    listenChannel,
    unlistenChannel,
    jsonLine,
    makeDeadClientHandler,
} from '../channels/db.ts'
import { checkRateLimit } from '../rateLimit.ts'
import { logger } from '../logger.ts'
import type { SseClient, ConnectedPayload, TokenExpiredPayload } from '../types.ts'

export async function handleEvents(
    request: Request,
    url: URL,
    cors: Record<string, string>,
    config: Config,
    server: { requestIP(req: Request): { address: string } | null },
    engine: ChannelRuleEngine
): Promise<Response> {
    // Rate limit
    const remoteIp = server.requestIP(request)?.address ?? 'unknown'
    if (!checkRateLimit(remoteIp, config.rateLimitPerMinute)) {
        return new Response('Too Many Requests', {
            status: 429,
            headers: { ...cors, 'Retry-After': '60' },
        })
    }

    // Auth
    const token = extractToken(request, url)
    if (!token) {
        return new Response('Unauthorized — provide a JWT via Authorization header or ?token=', {
            status: 401,
            headers: cors,
        })
    }
    if (token.length > 8192) {
        return new Response('Token too large', { status: 400, headers: cors })
    }
    const user = await verifyJwt(token, config)
    if (!user) {
        return new Response('Invalid or expired token', { status: 403, headers: cors })
    }

    // Channel params
    const channelParam = url.searchParams.get('channels')
    if (!channelParam) {
        return new Response(
            'Missing ?channels= — provide a comma-separated list of channel names',
            { status: 400, headers: cors }
        )
    }

    const rawChannels = channelParam
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)

    if (rawChannels.length === 0 || rawChannels.length > config.maxChannels) {
        return new Response(`Provide between 1 and ${config.maxChannels} channels`, {
            status: 400,
            headers: cors,
        })
    }

    // Deduplicate while preserving order.
    const channels = [...new Set(rawChannels)]

    // Channel rules
    const denial = engine.checkAll(channels, user)
    if (denial) {
        return new Response(denial.result.reason, {
            status: denial.result.status,
            headers: cors,
        })
    }

    // Connection caps
    if (clientsById.size >= config.maxTotalConnections) {
        return new Response('Service Unavailable — server at capacity', {
            status: 503,
            headers: cors,
        })
    }
    const userConnections = connectionCountByUser.get(user.id) ?? 0
    if (userConnections >= config.maxConnectionsPerUser) {
        return new Response(
            `Too Many Requests — max ${config.maxConnectionsPerUser} concurrent connections per user`,
            { status: 429, headers: { ...cors, 'Retry-After': '5' } }
        )
    }

    // Build SSE stream
    const onDead = makeDeadClientHandler(config)

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const id = crypto.randomUUID()
            const encoder = new TextEncoder()

            const client: SseClient = {
                id,
                channels: new Set(channels),
                user,
                alive: true,

                send(chunk: string): boolean {
                    if (!this.alive) return false
                    try {
                        controller.enqueue(encoder.encode(chunk))
                        return true
                    } catch {
                        this.alive = false
                        return false
                    }
                },

                close(): void {
                    if (!this.alive) return
                    this.alive = false
                    try {
                        controller.close()
                    } catch {
                        /* already closed */
                    }
                },
            }

            // Register before any async work so caps stay consistent.
            registerClient(client)

            // Start LISTEN on all channels; roll back on failure.
            try {
                await Promise.all(
                    channels.map((ch) => listenChannel(ch, config, onDead))
                )
            } catch (err) {
                controller.error(err)
                unregisterClient(client)
                for (const ch of channels) {
                    clientsByChannel.get(ch)?.delete(client)
                }
                return
            }

            // Instruct the browser to reconnect after 5 s on disconnect.
            client.send('retry: 5000\n')
            client.send(
                jsonLine('connected', {
                    id,
                    channels,
                    userId: user.id,
                } satisfies ConnectedPayload)
            )
            logger.info({ clientId: id, userId: user.id, channels }, '[connect]')

            // Token expiry
            const msUntilExpiry = user.expiresAt - Date.now()
            const tokenExpiry = setTimeout(async () => {
                client.send(
                    jsonLine('token_expired', {
                        reason: 'JWT expired — reconnect with a fresh token',
                    } satisfies TokenExpiredPayload)
                )
                clearInterval(heartbeat)
                await removeClient(client, (ch) => unlistenChannel(ch, config))
                logger.info({ clientId: id, userId: user.id }, '[token_expired]')
            }, Math.max(0, msUntilExpiry))

            // Heartbeat
            const heartbeat = setInterval(async () => {
                const ok = client.send(': ping\n\n')
                if (!ok) {
                    clearInterval(heartbeat)
                    clearTimeout(tokenExpiry)
                    await removeClient(client, (ch) => unlistenChannel(ch, config))
                    logger.warn({ clientId: id }, '[drop] broken pipe')
                }
            }, config.heartbeatMs)

            // Graceful disconnect
            request.signal.addEventListener('abort', async () => {
                clearInterval(heartbeat)
                clearTimeout(tokenExpiry)
                await removeClient(client, (ch) => unlistenChannel(ch, config))
                logger.info(
                    { clientId: id, userId: user.id, channels },
                    '[disconnect]'
                )
            })
        },
    })

    return new Response(stream, {
        headers: {
            ...cors,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        },
    })
}
