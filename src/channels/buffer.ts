import type { Config } from '../config.ts'

export type BufferedEvent = {
    readonly id: number
    readonly channel: string
    readonly data: string
    readonly timestamp: number
}

let nextId = 1

const buffers = new Map<string, BufferedEvent[]>()

export function pushEvent(channel: string, data: string, config: Config): number {
    const id = nextId++
    const entry: BufferedEvent = { id, channel, data, timestamp: Date.now() }

    let buf = buffers.get(channel)
    if (!buf) {
        buf = []
        buffers.set(channel, buf)
    }
    buf.push(entry)

    // Trim to max size
    if (buf.length > config.eventBufferSize) {
        buf.splice(0, buf.length - config.eventBufferSize)
    }

    return id
}

export function getEventsSince(
    channels: Iterable<string>,
    lastEventId: number,
    config: Config
): BufferedEvent[] {
    const now = Date.now()
    const result: BufferedEvent[] = []

    for (const channel of channels) {
        const buf = buffers.get(channel)
        if (!buf) continue
        for (const event of buf) {
            if (event.id <= lastEventId) continue
            if (now - event.timestamp > config.eventBufferTtlMs) continue
            result.push(event)
        }
    }

    result.sort((a, b) => a.id - b.id)
    return result
}

export function purgeExpired(config: Config): void {
    const now = Date.now()
    for (const [channel, buf] of buffers) {
        const cutoff = buf.findIndex((e) => now - e.timestamp <= config.eventBufferTtlMs)
        if (cutoff === -1) {
            buffers.delete(channel)
        } else if (cutoff > 0) {
            buf.splice(0, cutoff)
        }
    }
}

export function clearBuffer(channel: string): void {
    buffers.delete(channel)
}

export function _reset(): void {
    buffers.clear()
    nextId = 1
}
