import { describe, it, expect, beforeEach } from 'vitest'
import { pushEvent, getEventsSince, purgeExpired, _reset } from '../channels/buffer.ts'
import type { Config } from '../config.ts'

const baseConfig = {
    eventBufferSize: 5,
    eventBufferTtlMs: 60_000,
} as Config

beforeEach(() => _reset())

describe('pushEvent', () => {
    it('returns incrementing ids', () => {
        const id1 = pushEvent('ch1', '{"a":1}', baseConfig)
        const id2 = pushEvent('ch1', '{"a":2}', baseConfig)
        expect(id2).toBe(id1 + 1)
    })

    it('trims buffer to max size', () => {
        for (let i = 0; i < 10; i++) {
            pushEvent('ch1', `{"i":${i}}`, baseConfig)
        }
        const events = getEventsSince(['ch1'], 0, baseConfig)
        expect(events.length).toBe(5)
        expect(JSON.parse(events[0].data).i).toBe(5)
    })
})

describe('getEventsSince', () => {
    it('returns events after the given id', () => {
        const id1 = pushEvent('ch1', '{"v":1}', baseConfig)
        pushEvent('ch1', '{"v":2}', baseConfig)
        pushEvent('ch1', '{"v":3}', baseConfig)

        const events = getEventsSince(['ch1'], id1, baseConfig)
        expect(events.length).toBe(2)
        expect(JSON.parse(events[0].data).v).toBe(2)
        expect(JSON.parse(events[1].data).v).toBe(3)
    })

    it('returns events from multiple channels sorted by id', () => {
        pushEvent('ch1', '{"c":"ch1","i":1}', baseConfig)
        pushEvent('ch2', '{"c":"ch2","i":2}', baseConfig)
        pushEvent('ch1', '{"c":"ch1","i":3}', baseConfig)

        const events = getEventsSince(['ch1', 'ch2'], 0, baseConfig)
        expect(events.length).toBe(3)
        expect(events[0].id).toBeLessThan(events[1].id)
        expect(events[1].id).toBeLessThan(events[2].id)
    })

    it('skips expired events', async () => {
        pushEvent('ch1', '{"old":true}', baseConfig)

        await new Promise((r) => setTimeout(r, 5))
        const shortTtl = { ...baseConfig, eventBufferTtlMs: 1 } as Config
        const events = getEventsSince(['ch1'], 0, shortTtl)
        expect(events.length).toBe(0)
    })

    it('returns empty for unknown channels', () => {
        pushEvent('ch1', '{}', baseConfig)
        const events = getEventsSince(['unknown'], 0, baseConfig)
        expect(events.length).toBe(0)
    })
})

describe('purgeExpired', () => {
    it('removes channels with all expired events', async () => {
        pushEvent('ch1', '{}', baseConfig)

        await new Promise((r) => setTimeout(r, 5))
        const shortTtl = { ...baseConfig, eventBufferTtlMs: 1 } as Config
        purgeExpired(shortTtl)

        const events = getEventsSince(['ch1'], 0, baseConfig)
        expect(events.length).toBe(0)
    })

    it('keeps non-expired events', () => {
        pushEvent('ch1', '{"keep":true}', baseConfig)
        purgeExpired(baseConfig)

        const events = getEventsSince(['ch1'], 0, baseConfig)
        expect(events.length).toBe(1)
    })
})
