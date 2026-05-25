import { loadConfig } from './config.ts'
import { createServer } from './server.ts'
import { checkConnection } from './channels/db.ts'
import { initJwks } from './auth.ts'
import { startRateLimitPurge } from './rateLimit.ts'
import { purgeExpired } from './channels/buffer.ts'
import { logger } from './logger.ts'

const config = loadConfig()

// Eagerly verify the DB connection so a bad DATABASE_URL fails at startup.
checkConnection(config)
    .then(() => logger.info('[postgres] connected'))
    .catch((err) => {
        logger.error(err, '[postgres] connection failed')
        process.exit(1)
    })

// Fetch JWKS keys at startup so the first request doesn't incur a cold fetch.
initJwks(config)
    .then(() => logger.info('[jwks] initialized'))
    .catch((err) => {
        logger.error(err, '[jwks] initial fetch failed')
        process.exit(1)
    })

// Start background sweeper for the rate-limit window map.
startRateLimitPurge().unref()

// Purge expired events from the reconnection buffer every 60s.
setInterval(() => purgeExpired(config), 60_000).unref()

const server = createServer(config)
logger.info(`SSE server on http://localhost:${server.port}`)

