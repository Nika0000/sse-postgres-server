import postgres from 'postgres'
import type { Config } from '../config.ts'
import { listenHandles, pendingListens, clientsByChannel } from './registry.ts'
import type { SseClient, NotifyPayload } from '../types.ts'
import { logger } from '../logger.ts'
import { removeClient } from './registry.ts'

// Database connection
//
// max:2          - one connection for LISTEN, one spare for ad-hoc queries.
// idle_timeout:0 - never drop idle connections; LISTEN subscriptions must stay
//                  alive indefinitely.
// The `postgres` driver automatically reconnects LISTEN subscriptions after
// a dropped connection - no manual reconnect logic needed.

let _sql: ReturnType<typeof postgres> | null = null

export function getSql(config: Config): ReturnType<typeof postgres> {
    if (!_sql) {
        _sql = postgres(config.databaseUrl, {
            max: 2,
            idle_timeout: 0,
            connect_timeout: 10,
            onnotice: (notice) => logger.warn({ msg: notice.message }, '[postgres]'),
        })
    }
    return _sql
}

export async function checkConnection(config: Config): Promise<void> {
    const sql = getSql(config)
    await sql`SELECT 1`
}

export async function listenChannel(
    channel: string,
    config: Config,
    onDeadClients: (dead: SseClient[]) => void
): Promise<void> {
    if (listenHandles.has(channel)) return

    // A concurrent call for the same channel is already in flight — await it
    // rather than issuing a second sql.listen(), which would create duplicate
    // handlers and memory leaks.
    const inflight = pendingListens.get(channel)
    if (inflight) return inflight

    const sql = getSql(config)

    const promise = (async () => {
        const handle = await sql.listen(channel, (rawPayload) => {
            const targets = clientsByChannel.get(channel)
            if (!targets || targets.size === 0) return

            let parsed: unknown
            try {
                parsed = JSON.parse(rawPayload)
            } catch {
                parsed = rawPayload
            }

            const wire = jsonLine('postgres_notify', {
                channel,
                payload: parsed,
                timestamp: new Date().toISOString(),
            } satisfies NotifyPayload)

            // Fan-out; collect broken clients for async cleanup.
            const dead: SseClient[] = []
            for (const client of targets) {
                if (!client.send(wire)) dead.push(client)
            }

            if (dead.length > 0) {
                queueMicrotask(() => onDeadClients(dead))
            }
        })

        listenHandles.set(channel, handle)
        logger.info(`[listen] ${channel}`)
    })()

    pendingListens.set(channel, promise)
    try {
        await promise
    } finally {
        pendingListens.delete(channel)
    }
}

export async function unlistenChannel(
    channel: string,
    config: Config
): Promise<void> {
    const handle = listenHandles.get(channel)
    if (!handle) return
    await handle.unlisten()
    listenHandles.delete(channel)
    getSql(config) // keep ref alive
    logger.info(`[unlisten] ${channel}`)
}


export function jsonLine(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

export function makeDeadClientHandler(config: Config) {
    return (dead: SseClient[]) => {
        for (const client of dead) {
            removeClient(client, (ch) => unlistenChannel(ch, config)).catch((err) =>
                logger.error(err, `[remove error] ${client.id}`)
            )
        }
        logger.warn(`[drop] ${dead.length} broken client(s)`)
    }
}
