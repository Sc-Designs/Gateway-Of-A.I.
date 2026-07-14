# 🚪 AI-Powered Hiring & Assessment Platform — API Gateway

The central entry point for the **AI-Powered Hiring & Assessment Platform**. This service sits between the frontend and all backend microservices, handling request routing, rate limiting, real-time socket communication, and cross-service orchestration.

---

## Architecture Overview

```
Client (React / Netlify)
        │
        ▼
 ┌──────────────┐
 │  API Gateway │  ← You are here
 │  (Express)   │
 └──────┬───────┘
        │
        ├── /user    → User Service
        ├── /admin   → Admin Service
        ├── /orgs    → Organization Service
        ├── /test    → Test/Assessment Service
        ├── /result  → Result Service
        └── /ai      → AI Scoring Service

 Socket.IO ──────────────────────────────────────────────┐
        │                                                  │
        ├── block-user    → proxies to User Service        │
        ├── block-org     → proxies to Org Service         │
        └── set-delete    → proxies to Test Service        │
                                                           │
 Redis (ioredis) ← Rate limit store ─────────────────────┘
```

---

## Features

- **Reverse Proxy** — Routes all client traffic to the correct upstream microservice using `express-http-proxy`, with prefix stripping and host header forwarding.
- **Rate Limiting** — Tiered rate limiting via `express-rate-limit` backed by Redis:
  - Global: 2,000 req / 15 min
  - User routes: 500 req / 10 min
  - Admin routes: 200 req / 10 min
- **Real-Time Events** — `Socket.IO` server for live admin actions (block/unblock users & orgs, delete test sets) without requiring page refreshes.
- **Multipart Passthrough** — File upload requests (`multipart/form-data`) are streamed directly without body parsing to preserve integrity.
- **CORS** — Locked to the production frontend origin with credentials support.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM) |
| Framework | Express 5 |
| Proxy | express-http-proxy |
| Real-time | Socket.IO 4 |
| Rate Limiting | express-rate-limit + rate-limit-redis |
| Cache / Store | Redis (ioredis) |
| HTTP Client | Axios (socket handlers) |
| Logging | Morgan |

---

## Getting Started

### Prerequisites

- Node.js 18+
- A running Redis instance
- All downstream microservices running and accessible

### Installation

```bash
git clone https://github.com/Sc-Designs/Gateway-Of-A.I..git
cd gateway
npm install
```

### Environment Variables

Create a `.env` file in the root:

```env
PORT=3000

# Downstream microservice URLs
ADMIN_API_URL=http://localhost:3001
AI_API_URL=http://localhost:3002
ORG_API_URL=http://localhost:3003
RESULT_API_URL=http://localhost:3004
TEST_API_URL=http://localhost:3005
USER_API_URL=http://localhost:3006

# Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
```

### Running

```bash
# Development (with hot reload)
npm run dev

# Production
npm start
```

The gateway will start on `http://localhost:3000` (or the `PORT` you set).

---

## API Routes

All routes are proxied transparently. The gateway does not implement business logic — it forwards requests with the original headers (including `Authorization`) intact.

| Prefix | Upstream Service | Rate Limit |
|---|---|---|
| `GET /` | Health check response | Global |
| `/user/*` | User Service | 500 / 10 min |
| `/admin/*` | Admin Service | 200 / 10 min |
| `/orgs/*` | Organization Service | Global |
| `/test/*` | Test/Assessment Service | Global |
| `/result/*` | Result Service | Global |
| `/ai/*` | AI Scoring Service | Global |

> **Note:** The `/user` prefix is stripped before forwarding (e.g. `/user/login` → `/login` on the User Service).

---

## Socket.IO Events

The gateway runs a Socket.IO server that handles privileged real-time actions. All socket handlers call upstream services via Axios using the token passed in the event payload.

### Connection & Rooms

```js
// Client joins a room on connect
socket.emit("join", { role: "admin" | "org" | "user", id: "<entityId>" });

// Ping/pong health check
socket.emit("pingCheck");    // server responds with "pongCheck"
```

### Admin Events

#### `block-user`
Blocks or unblocks a user. Calls the User Service internally.

| Field | Type | Description |
|---|---|---|
| `from` | string | Emitting socket ID |
| `give` | string | Admin ID (for response room targeting) |
| `to` | string | User ID to block/unblock |
| `token` | string | Bearer token for auth |

**Emits back:**
- `block-user-success` → room `admin-{give}`
- `blocked` → room `user-{to}`
- `block-user-failed` → room `admin-{socketId}` (on error)

---

#### `block-org`
Blocks or unblocks an organization. Calls the Org Service internally.

| Field | Type | Description |
|---|---|---|
| `from` | string | Emitting socket ID |
| `give` | string | Admin ID (for response room targeting) |
| `to` | string | Org ID to block/unblock |
| `token` | string | Bearer token for auth |

**Emits back:**
- `block-org-success` → room `admin-{give}`
- `blocked` → room `org-{to}`
- `block-user-failed` → room `admin-{socketId}` (on error)

---

#### `set-delete`
Deletes a test set. Calls the Test Service internally.

| Field | Type | Description |
|---|---|---|
| `from` | string | Emitting socket ID |
| `give` | string | Org ID (for response room targeting) |
| `token` | string | Bearer token for auth |
| `data` | string | Set ID to delete |

**Emits back:**
- `set-delete-success` → room `org-{give}` (includes `setId` and optional `warning`)
- `set-delete-failed` → room `org-{give}` (on error)

---

## Project Structure

```
gateway/
├── socket/
│   └── socketHandler.js   # All Socket.IO event logic
├── app.js                 # Express app, proxy config, rate limiters
├── server.js              # HTTP server + Socket.IO initialization
├── redisClient.js         # Shared ioredis connection
├── package.json
└── .env                   # (not committed)
```

---

## Deployment Notes

- Set `app.set("trust proxy", 1)` is already configured — required when running behind a load balancer or Nginx so rate limiting uses the real client IP.
- CORS is locked to the Netlify production URL. Update `origin` in both `app.js` and `server.js` if the frontend domain changes.
- Redis must be reachable before the gateway starts, otherwise rate limiters will fail silently. Consider adding a Redis readiness check in production.
- In Docker Compose, ensure all microservice containers are on the same network and their hostnames match the `*_API_URL` env vars.

---

## Related Services

This gateway is one part of the larger AI Interview Platform monorepo. Other services include:

- **User Service** — Candidate authentication, profile management
- **Org Service** — Organization auth, settings, candidate management
- **Admin Service** — Platform-level admin controls
- **Test Service** — Question bank, test set creation and management
- **AI Service** — Voice/text assessment scoring and rationale generation
- **Result Service** — Score storage, retrieval, and report generation

---

## License

Private — All rights reserved.