import { loadConfig } from './config.ts'
import { createServer } from './server.ts'
import { checkConnection } from './channels/db.ts'
import { startRateLimitPurge } from './rateLimit.ts'
import { logger } from './logger.ts'
import { ruleEngine } from './channels/config.ts'
import { engineFromEnv } from './channels/env-rules.ts'

const config = loadConfig()

const engine = engineFromEnv() ?? ruleEngine

// Eagerly verify the DB connection so a bad DATABASE_URL fails at startup.
checkConnection(config)
    .then(() => logger.info('[postgres] connected'))
    .catch((err) => {
        logger.error(err, '[postgres] connection failed')
        process.exit(1)
    })

// Start background sweeper for the rate-limit window map.
startRateLimitPurge().unref()

const server = createServer(config, engine)
logger.info(`SSE server on http://localhost:${server.port}`)

