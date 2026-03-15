import type { SseClient, ListenHandle } from '../types.ts'

/** All active clients indexed by their unique id. */
export const clientsById = new Map<string, SseClient>()

/** Clients grouped by channel — used for fan-out on NOTIFY. */
export const clientsByChannel = new Map<string, Set<SseClient>>()

/** Active connection count per user id — enforces per-user cap. */
export const connectionCountByUser = new Map<string, number>()

/** Active sql.listen() handles — one per channel. */
export const listenHandles = new Map<string, ListenHandle>()

/**
 * In-flight sql.listen() promises — prevents duplicate LISTEN calls when
 * multiple clients concurrently subscribe to the same brand-new channel.
 */
export const pendingListens = new Map<string, Promise<void>>()

/** Exact count of unique connected clients (each client counted once). */
export function totalClients(): number {
    return clientsById.size
}

/**
 * Register a newly built client in all indexes *before* any async work so
 * rate/cap checks are always consistent even under concurrent requests.
 */
export function registerClient(client: SseClient): void {
    clientsById.set(client.id, client)
    connectionCountByUser.set(
        client.user.id,
        (connectionCountByUser.get(client.user.id) ?? 0) + 1
    )
    for (const channel of client.channels) {
        if (!clientsByChannel.has(channel)) {
            clientsByChannel.set(channel, new Set())
        }
        clientsByChannel.get(channel)!.add(client)
    }
}

/**
 * Undo a `registerClient` call, e.g. on LISTEN failure before the stream
 * has been returned to the browser.
 */
export function unregisterClient(client: SseClient): void {
    clientsById.delete(client.id)
    const count = connectionCountByUser.get(client.user.id) ?? 1
    if (count <= 1) connectionCountByUser.delete(client.user.id)
    else connectionCountByUser.set(client.user.id, count - 1)
    for (const channel of client.channels) {
        clientsByChannel.get(channel)?.delete(client)
    }
}

/**
 * Add a single channel to an existing live client.
 * Caller is responsible for calling `listenChannel` AFTER this.
 */
export function addClientChannel(client: SseClient, channel: string): void {
    client.channels.add(channel)
    if (!clientsByChannel.has(channel)) clientsByChannel.set(channel, new Set())
    clientsByChannel.get(channel)!.add(client)
}

/**
 * Remove a single channel from an existing live client, UNLISTEN if the
 * channel becomes empty.
 */
export async function removeClientChannel(
    client: SseClient,
    channel: string,
    unlistenFn: (channel: string) => Promise<void>
): Promise<void> {
    client.channels.delete(channel)
    const members = clientsByChannel.get(channel)
    if (!members) return
    members.delete(client)
    if (members.size === 0) {
        clientsByChannel.delete(channel)
        await unlistenFn(channel)
    }
}

/**
 * Remove a client from every index, UNLISTEN any channel that is now empty,
 * and close its stream.  Safe to call multiple times — idempotent via
 * `clientsById` membership check.
 */
export async function removeClient(
    client: SseClient,
    unlistenFn: (channel: string) => Promise<void>
): Promise<void> {
    if (!clientsById.has(client.id)) return // already removed

    unregisterClient(client)

    for (const channel of client.channels) {
        const members = clientsByChannel.get(channel)
        if (!members) continue
        members.delete(client)
        if (members.size === 0) {
            clientsByChannel.delete(channel)
            unlistenFn(channel).catch((err) =>
                console.error(`[unlisten error] ${channel}`, err)
            )
        }
    }

    client.close()
}
