# sse-postgres-server

[![CI](https://github.com/Nika0000/sse-postgres-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Nika0000/sse-postgres-server/actions/workflows/ci.yml)
[![Docker](https://github.com/Nika0000/sse-postgres-server/actions/workflows/docker.yml/badge.svg)](https://github.com/Nika0000/sse-postgres-server/actions/workflows/docker.yml)
[![Image](https://ghcr-badge.egpl.dev/Nika0000/sse-postgres-server/latest_tag?label=ghcr.io)](https://github.com/Nika0000/sse-postgres-server/pkgs/container/sse-postgres-server)
[![Bun](https://img.shields.io/badge/runtime-bun-fbf0df?logo=bun)](https://bun.sh)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

PostgreSQL `LISTEN/NOTIFY` -> HTTP SSE bridge. JWT-authenticated, rate-limited, zero runtime dependencies outside of Bun + postgres driver.

---

## Quick start

```bash
bun install
cp .env.example .env   # fill in DATABASE_URL + SUPABASE_JWT_SECRET
bun run dev
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | &check; | — | postgres connection string |
| `SUPABASE_JWT_SECRET` | &check; | — | JWT signing secret |
| `CHANNEL_RULES` | &cross; | see below | JSON channel access rules |
| `PORT` | &cross; | `3000` | HTTP listen port |
| `SUPABASE_JWT_AUDIENCE` | &cross; | — | Validates the `aud` claim |
| `CORS_ORIGIN` | &cross; | `*` | Allowed origin or `*` |
| `SSE_HEARTBEAT_MS` | &cross; | `15000` | Keepalive interval |
| `MAX_CHANNELS_PER_CONNECTION` | &cross; | `10` | Channels per SSE connection |
| `MAX_CONNECTIONS_PER_USER` | &cross; | `10` | Concurrent connections per user |
| `MAX_TOTAL_CONNECTIONS` | &cross; | `1000` | Server-wide connection cap |
| `RATE_LIMIT_PER_MINUTE` | &cross; | `30` | Requests/min per IP |

## Usage

```bash
# subscribe — token via query string
curl -N "http://localhost:3000/events?channels=orders&token=<jwt>"

# multiple channels in one connection
curl -N "http://localhost:3000/events?channels=global,orders,user_<uuid>&token=<jwt>"

# user sub-channels (session, payments, orders …)
curl -N "http://localhost:3000/events?channels=user_<uuid>:session,user_<uuid>:payments&token=<jwt>"

# wildcard — subscribes to the base channel, receives all sub-event types
curl -N "http://localhost:3000/events?channels=user_<uuid>:*&token=<jwt>"

# server-to-server — token via header
curl -N -H "Authorization: Bearer <jwt>" "http://localhost:3000/events?channels=orders"

# publish from postgres — SSE event name IS the channel name
psql $DATABASE_URL -c "SELECT pg_notify('orders', '{\"event\":\"created\",\"data\":{\"id\":1}}')"

# health check
curl http://localhost:3000/health
# -> {"ok":true,"clients":2,"channels":1}
```

### SSE wire format

Each message arrives as an SSE event whose **`event:` field is the channel name**:

```
event: orders
data: {"channel":"orders","payload":{"event":"created","data":{"id":1}},"timestamp":"2026-03-08T12:00:00.000Z"}

event: connected
data: {"id":"<client-uuid>","channels":["orders"],"userId":"<user-uuid>"}
```

```js
const es = new EventSource('/events?channels=orders,user_<uuid>:*&token=<jwt>')

// named handler per channel
es.addEventListener('orders', (e) => {
  const { payload } = JSON.parse(e.data)
  // payload = { event: 'created', data: { id: 1 } }
})

// wildcard: base channel name is the event label
es.addEventListener(`user_${uid}`, (e) => {
  const { payload } = JSON.parse(e.data)
  switch (payload.event) {
    case 'session_active':   ...; break
    case 'payment_completed': ...; break
  }
})
```

## Channel rules

Rules run top-to-bottom — first match wins.

| Pattern | Who can subscribe |
|---|---|
| `user_{uuid}` | The user whose UUID matches only |
| `user_{uuid}:{subchannel}` | Same — sub-channel scoped to the same owner |
| `user_{uuid}:*` | Wildcard — resolves to `user_{uuid}`, receives all notifications on it |
| `role_{name}` | Users whose JWT `role` equals the suffix |
| `org_{id}` | Users with `app_metadata.org_id === id` |
| `private_*` | Any non-anonymous user |
| everything else | Any authenticated user |

> Channel names may contain letters, digits, underscores `_`, hyphens `-`, and colons `:`. They must start with a letter or underscore. Hyphens allow UUID-style names (`user_1b8f4c33-…`). Colons enable sub-channels and wildcards.

### Configure without rebuilding (`CHANNEL_RULES`)

Set `CHANNEL_RULES` as a JSON array to control access entirely from your environment — no code changes, no image rebuild needed.

```bash
CHANNEL_RULES='[
  { "type": "exact",     "channel": "announcements" },
  { "type": "exact",     "channel": "global"        },
  { "type": "role_gate", "channel": "admin_events",  "role": "admin"      },
  { "type": "meta_gate", "channel": "beta",          "key": "beta",  "value": true  },
  { "type": "meta_gate", "channel": "pro_feed",      "key": "plan",  "value": "pro" },
  { "type": "prefix_meta", "prefix": "lobby_", "key": "lobby_id" },
  { "type": "team_prefix"    },
  { "type": "user_prefix"    },
  { "type": "role_prefix"    },
  { "type": "org_prefix"     },
  { "type": "private_prefix" },
  { "type": "deny_unlisted"  }
]'
```

| Rule type | Description |
|---|---|
| `exact` | Named channel, open to any authenticated user |
| `role_gate` | Named channel, JWT role must match |
| `meta_gate` | Named channel, `app_metadata[key] === value` |
| `prefix_meta` | `{prefix}{id}` — `app_metadata[key]` must equal the suffix; works for any prefix with no code changes |
| `team_prefix` | `team_{id}` — needs `app_metadata.team_id` |
| `plan_prefix` | `plan_{tier}` — tiered gate (`free` -> `starter` -> `pro` -> `enterprise`) |
| `user_prefix` | `user_{uuid}` — owner-only (also covers `user_{uuid}:{sub}` and `user_{uuid}:*`) |
| `role_prefix` | `role_{name}` — JWT role must match suffix |
| `org_prefix` | `org_{id}` — `app_metadata.org_id` must match |
| `private_prefix` | `private_*` — any non-anon user |
| `public` | Catch-all allow |
| `deny_unlisted` | Catch-all deny (strict allowlist) |

If `CHANNEL_RULES` is not set, the programmatic config in `src/channels/config.ts` is used instead.

### Postgres trigger (push events automatically)

```sql
CREATE OR REPLACE FUNCTION notify_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('orders', json_build_object('op', TG_OP, 'id', NEW.id)::text);
  RETURN NEW;
END $$;

CREATE TRIGGER orders_notify
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION notify_row();
```

> Postgres `NOTIFY` payload limit is 8 KB — send IDs, not full rows.

## Docker

```bash
# local stack — app + postgres:17
docker compose -f docker/compose.yml up

# pull published image
docker pull ghcr.io/Nika0000/sse-postgres-server:latest

# pin a specific build in production
docker pull ghcr.io/Nika0000/sse-postgres-server:2026.03.08.1045
```

## Development

```bash
bun run test
bun run typecheck  # tsc --noEmit
bun run lint       # eslint src
```
