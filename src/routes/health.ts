import type { Config } from '../config.ts'
import { totalClients, clientsByChannel } from '../channels/registry.ts'
import type { HealthResponse } from '../types.ts'

export function handleHealth(config: Config, cors: Record<string, string>): Response {
    return Response.json(
        {
            ok: true,
            clients: totalClients(),
            channels: clientsByChannel.size,
            uptime: Math.floor(process.uptime()),
            auth: !!config.jwtSecret,
        } satisfies HealthResponse,
        { headers: cors }
    )
}
