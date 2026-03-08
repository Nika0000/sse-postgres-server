// Tracks the timestamps of /events connection attempts within the last minute
// for each remote IP.  When the count exceeds the configured cap the request
// is rejected with 429.

const WINDOW_MS = 60_000

const windows = new Map<string, number[]>()

export function checkRateLimit(ip: string, limitPerMinute: number): boolean {
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    const hits = (windows.get(ip) ?? []).filter((t) => t > cutoff)
    if (hits.length >= limitPerMinute) return false
    hits.push(now)
    windows.set(ip, hits)
    return true
}

/** Purge stale entries to prevent unbounded memory growth. */
export function startRateLimitPurge(): ReturnType<typeof setInterval> {
    return setInterval(() => {
        const cutoff = Date.now() - WINDOW_MS
        for (const [ip, hits] of windows) {
            const fresh = hits.filter((t) => t > cutoff)
            if (fresh.length === 0) windows.delete(ip)
            else windows.set(ip, fresh)
        }
    }, WINDOW_MS)
}
