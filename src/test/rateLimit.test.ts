import { describe, test, expect, vi, beforeEach } from 'vitest'
import { checkRateLimit } from '../rateLimit.ts'

// The module keeps state in a module-level Map, so we re-import per test
// by isolating it. Here we just reset time using vi.useFakeTimers.

describe('checkRateLimit', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    test('allows requests up to the limit', () => {
        const ip = `ip-${Math.random()}`
        for (let i = 0; i < 5; i++) {
            expect(checkRateLimit(ip, 5)).toBe(true)
        }
        // 6th request exceeds the cap
        expect(checkRateLimit(ip, 5)).toBe(false)
    })

    test('resets after the window expires', () => {
        const ip = `ip-${Math.random()}`
        for (let i = 0; i < 5; i++) checkRateLimit(ip, 5)
        expect(checkRateLimit(ip, 5)).toBe(false)

        // Advance 61 seconds — all previous hits fall outside the window
        vi.advanceTimersByTime(61_000)
        expect(checkRateLimit(ip, 5)).toBe(true)
    })

    test('isolates different IPs', () => {
        const ip1 = `ip1-${Math.random()}`
        const ip2 = `ip2-${Math.random()}`
        for (let i = 0; i < 3; i++) checkRateLimit(ip1, 3)
        // ip1 is exhausted, ip2 should still be free
        expect(checkRateLimit(ip1, 3)).toBe(false)
        expect(checkRateLimit(ip2, 3)).toBe(true)
    })
})
