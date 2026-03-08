// Shared domain types

export type AuthUser = {
    readonly id: string
    readonly email: string | null
    readonly role: string
    readonly appMetadata: Record<string, unknown>
    readonly userMetadata: Record<string, unknown>
    /** Unix epoch ms — when the JWT expires. Used to close the stream at expiry. */
    readonly expiresAt: number
}

/**
 * An active SSE subscriber.
 * `send` returns false when the underlying stream has broken — callers must
 * treat a false return as "drop this client".
 */
export type SseClient = {
    readonly id: string
    /** All channels this connection is currently subscribed to. */
    readonly channels: ReadonlySet<string>
    readonly user: AuthUser
    alive: boolean
    send: (chunk: string) => boolean
    close: () => void
}

export type ListenHandle = {
    unlisten: () => Promise<void>
}

// Wire payloads (SSE event data shapes)

export type NotifyPayload = {
    readonly channel: string
    readonly payload: unknown
    readonly timestamp: string
}

export type ConnectedPayload = {
    readonly id: string
    readonly channels: readonly string[]
    readonly userId: string
}

export type TokenExpiredPayload = {
    readonly reason: string
}

export type HealthResponse = {
    readonly ok: boolean
    readonly clients: number
    readonly channels: number
    readonly uptime: number
    readonly auth: boolean
}
