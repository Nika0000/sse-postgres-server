export function isWildcard(channel: string): boolean {
    return channel.endsWith(':*')
}

export function resolveChannel(channel: string): string {
    return isWildcard(channel) ? channel.slice(0, -2) : channel
}
