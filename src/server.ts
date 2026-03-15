import type { Config } from './config.ts'
import type { ChannelRuleEngine } from './channels/rules.ts'
import { handleHealth } from './routes/health.ts'
import { handleEvents } from './routes/events.ts'
import { handleChannelUpdate } from './routes/channels.ts'
import { logger } from './logger.ts'

function corsHeaders(config: Config, requestOrigin: string | null): Record<string, string> {
    const origin =
        config.corsOrigin === '*' ? (requestOrigin ?? '*') : config.corsOrigin
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, Cache-Control',
        'Access-Control-Max-Age': '86400',
        ...(config.corsOrigin !== '*' ? { Vary: 'Origin' } : {}),
    }
}

/**
 * Creates and returns a Bun HTTP server bound to `config.port`.
 * Exported separately from the entry point so tests can spin up an instance
 * without side effects (no process.exit, no console noise).
 */
export function createServer(
    config: Config,
    engine: ChannelRuleEngine
): ReturnType<typeof Bun.serve> {
    const server = Bun.serve({
        port: config.port,
        idleTimeout: 0,

        async fetch(request: Request): Promise<Response> {
            const url = new URL(request.url)
            const cors = corsHeaders(config, request.headers.get('Origin'))

            // ── CORS preflight ──────────────────────────────────────────────────────
            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: cors })
            }

            // ── Routes ──────────────────────────────────────────────────────────────
            if (request.method === 'GET' && url.pathname === '/health') {
                return handleHealth(config, cors)
            }

            if (request.method === 'GET' && url.pathname === '/events') {
                return handleEvents(request, url, cors, config, server, engine)
            }

            if (request.method === 'PATCH' && url.pathname === '/events/channels') {
                return handleChannelUpdate(request, url, cors, config, engine)
            }

            if (url.pathname !== '/events' && url.pathname !== '/health' && url.pathname !== '/events/channels') {
                return new Response('Not Found', { status: 404, headers: cors })
            }

            return new Response('Method Not Allowed', { status: 405, headers: cors })
        },

        error(err: Error): Response {
            logger.error(err, '[server error]')
            return new Response('Internal Server Error', { status: 500 })
        },
    })

    return server
}
