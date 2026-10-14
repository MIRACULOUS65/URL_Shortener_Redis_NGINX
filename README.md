# URL Shortener — System Design Lab

> A learning-first backend project that evolves from a basic in-memory URL shortener into a PostgreSQL-backed, authenticated, containerized service with three API instances, Nginx load balancing, Redis shared state, and Redis cache-aside URL resolution.
>
> **Project status:** the main learning milestones have been implemented and manually exercised. This is a system-design lab, not a production-hardened URL-shortening service. Some benchmark runs showed connection errors and intermittent Neon connectivity failures; those findings are documented below rather than hidden.

---

## Table of contents

- [1. Project purpose](#1-project-purpose)
- [2. What was built](#2-what-was-built)
- [3. Tech stack and why each component exists](#3-tech-stack-and-why-each-component-exists)
- [4. Architecture evolution](#4-architecture-evolution)
- [5. Current architecture](#5-current-architecture)
- [6. Repository structure](#6-repository-structure)
- [7. Prerequisites](#7-prerequisites)
- [8. Configuration and secrets](#8-configuration-and-secrets)
- [9. Local setup and commands](#9-local-setup-and-commands)
- [10. API reference](#10-api-reference)
- [11. Data model](#11-data-model)
- [12. Authentication and ownership](#12-authentication-and-ownership)
- [13. Docker implementation](#13-docker-implementation)
- [14. Horizontal scaling and Nginx](#14-horizontal-scaling-and-nginx)
- [15. Process-local state experiment](#15-process-local-state-experiment)
- [16. Redis shared-state experiment](#16-redis-shared-state-experiment)
- [17. Redis cache-aside implementation](#17-redis-cache-aside-implementation)
- [18. Failure and recovery experiments](#18-failure-and-recovery-experiments)
- [19. Benchmark methodology](#19-benchmark-methodology)
- [20. Benchmark results](#20-benchmark-results)
- [21. Errors encountered and what they taught us](#21-errors-encountered-and-what-they-taught-us)
- [22. Troubleshooting guide](#22-troubleshooting-guide)
- [23. Security and production-readiness gaps](#23-security-and-production-readiness-gaps)
- [24. Lessons learned](#24-lessons-learned)
- [25. Future experiments](#25-future-experiments)
- [26. Glossary](#26-glossary)

---

## 1. Project purpose

This project was built as a practical system-design laboratory rather than as a tutorial-copying exercise. The guiding loop was:

1. Build a small working feature.
2. Measure or deliberately break it.
3. Observe the actual failure or bottleneck.
4. Explain why the behavior happens.
5. Add the smallest architectural component that addresses the observed problem.
6. Repeat the test and record what changed.

The project started with a simple URL shortener and then evolved in stages to explore:

- application layering and separation of concerns;
- TypeScript compilation into JavaScript;
- PostgreSQL persistence through Prisma;
- user authentication and resource ownership;
- benchmarking with Autocannon;
- Docker images and containers;
- horizontal scaling with multiple application instances;
- reverse proxying and round-robin load balancing with Nginx;
- instance failure and recovery;
- the difference between process-local state and shared state;
- Redis as a shared data store;
- Redis cache-aside reads with TTL expiry;
- fallback to PostgreSQL while Redis is unavailable.

The key objective was not to make the largest possible benchmark number. It was to understand **why the architecture changes, what each component contributes, and which trade-offs those components introduce**.

## 2. What was built

### Core application

- Generate a short code for a destination URL.
- Persist URL records in Neon PostgreSQL through Prisma.
- Redirect a short code to its original destination.
- Associate URLs with authenticated users.
- Register and log in users using password hashes and JWTs.
- List the authenticated user's URLs.

### System-design experiments

- Compare a health endpoint with a database-backed redirect endpoint.
- Run the application natively and in Docker.
- Run three copies of the same API image.
- Place Nginx in front of those API instances.
- Identify the serving replica through `/whoami`.
- Stop one API container and observe whether the others keep serving requests.
- Demonstrate that each Node.js process has independent in-memory state.
- Store one shared counter in Redis and increment it from different API replicas.
- Cache short-code-to-destination lookups in Redis, keeping PostgreSQL as the durable source of truth.
- Test the redirect path while Redis is stopped and confirm that database fallback works when PostgreSQL is reachable.
- Compare observed latency and throughput for the PostgreSQL-only and Redis-cache redirect paths.

### Deliberate scope boundary

This is **not yet production-ready**. It is a functional learning project with some debug/benchmark endpoints and known issues. The known limitations are listed in [Security and production-readiness gaps](#23-security-and-production-readiness-gaps).

## 3. Tech stack and why each component exists

| Technology | Role in this project | Why it was introduced |
|---|---|---|
| TypeScript | Application language | Static types, clearer contracts between layers, compile-time checking. |
| Node.js | JavaScript runtime | Runs the compiled backend. |
| Express | HTTP server and router | Defines endpoints and middleware. |
| TypeScript compiler (`tsc -b`) | Build step | Compiles TypeScript into JavaScript under `dist/`. |
| Prisma ORM | Data access | Typed database queries and Prisma Client generation. |
| Prisma 6.19.3 | ORM version observed in the project | Kept on Prisma 6 for this learning iteration. |
| Neon PostgreSQL | Hosted relational database | Durable persistence for users and URLs, without managing a local DB server. |
| `bcryptjs` | Password hashing | Stores password hashes rather than plaintext passwords. |
| `jsonwebtoken` | JWT signing and verification | Authenticates protected API requests. |
| `redis` Node client | Redis client library | Lets each API instance access the same Redis service. |
| Redis 7 (`redis:7-alpine`) | Shared data and cache | Demonstrates shared state and avoids repeated database reads on warm cache hits. |
| Docker Desktop with WSL 2 backend | Local container runtime on Windows | Runs the API, Redis, and Nginx reproducibly without an AWS server. |
| Docker Compose | Local multi-service orchestration | Defines and starts the API replicas, Nginx, and Redis together. |
| Nginx (`nginx:alpine`) | Reverse proxy/load balancer | Exposes one host port and distributes requests among API instances. |
| Autocannon 8.0.0 | HTTP load generator observed from `npx` output | Measures request rate, latency percentiles, and client-side errors. |
| PowerShell | Local commands and test scripts | Runs build, Compose, curl, route verification, and benchmark commands on Windows. |

### Why not use every component from day one?

We intentionally did **not** start with Kubernetes, AWS, a message queue, or a local PostgreSQL container. The application uses Neon for PostgreSQL, and Docker was introduced only after the native application and baseline benchmark existed. Redis was introduced only after an in-memory counter demonstrated the shared-state problem.

## 4. Architecture evolution

### Phase 1 — Basic in-memory URL shortener

The first version generated a short code and stored the mapping in process memory.

```text
Client
  |
  v
Express API
  |
  v
In-memory Map
  |
  v
Redirect
```

**Lesson:** memory is easy to use, but it disappears when the process restarts and is not shared between separate processes.

### Phase 2 — Persistent storage with Neon and Prisma

The URL mapping moved from the in-memory map to PostgreSQL.

```text
Client -> Express -> Controller -> Service -> Repository -> Prisma -> Neon PostgreSQL
```

**Lesson:** data survives API restarts because PostgreSQL, rather than the Node.js process, owns the durable records.

### Phase 2.x — Authentication and ownership

The app gained registration, login, JWT middleware, password hashing, and user-owned URL records. `Url.userId` became required after the initial optional relation experiment and removal of the lone test URL with a null owner.

### Phase 3 — Native baseline benchmarking

We compared:

- `/health`, which returns a small response without a database query;
- `/:code`, which resolves a short code through Prisma/PostgreSQL and returns a redirect.

**Lesson:** a cheap application-only endpoint and a database-backed endpoint have very different costs. The remote database/network path dominated the observed redirect latency in these tests, although the benchmarks alone do not isolate every contributor.

### Phase 4 — Dockerization

The existing TypeScript application was built into a multi-stage Docker image. The native workflow remained available. The `.env` file was not copied into the image; Compose injects environment variables at runtime.

### Phase 5/6 — Three API replicas behind Nginx

```text
Client -> Nginx -> API 1 --+
                 API 2 ----+--> Neon PostgreSQL
                 API 3 --+  \
                           Redis (added later)
```

Nginx listens on host port `8080`; API containers listen internally on port `3000`. They share an image and environment, with a distinct `INSTANCE_ID` for diagnostics.

### Phase 8 — Process-local counter

Each API had its own `let counter = 0`. The repeated requests showed the counter restarting independently at each replica, proving that local memory is not global state.

### Phase 9 — Redis shared counter

The APIs incremented the same Redis key `lab:shared-counter:v1`. The counter increased continuously across API replicas, including when API 2 was stopped.

### Phase 10 — Redis URL cache

The redirect service checks Redis first, queries PostgreSQL on a cache miss, and stores a successful lookup in Redis with a 300-second TTL. Redis is an optimization; PostgreSQL remains the source of truth.

> Phase numbering is retained from the experiment sequence. Some numbers were used for small subphases or diagnostics, so the phase labels are a learning timeline rather than a strict release-version scheme.

## 5. Current architecture

### Full local setup

```mermaid
flowchart TD
    Client[Browser / curl / Autocannon]
    Nginx[Nginx reverse proxy :8080]
    API1[API 1 :3000]
    API2[API 2 :3000]
    API3[API 3 :3000]
    Redis[(Redis :6379)]
    Prisma[Prisma Client]
    Neon[(Neon PostgreSQL)]

    Client --> Nginx
    Nginx --> API1
    Nginx --> API2
    Nginx --> API3

    API1 --> Redis
    API2 --> Redis
    API3 --> Redis

    API1 --> Prisma
    API2 --> Prisma
    API3 --> Prisma
    Prisma --> Neon
```

The API replicas run on one physical computer. This tests process/container-level scaling and routing, **not** scaling across three independent physical servers. All three share the same laptop CPU/memory, Redis container, and remote Neon database.

### Redirect request, cache miss

```mermaid
sequenceDiagram
    participant C as Client
    participant N as Nginx
    participant A as One API replica
    participant R as Redis
    participant P as Prisma
    participant DB as Neon PostgreSQL

    C->>N: GET /shortCode
    N->>A: Proxy request
    A->>R: GET url:redirect:v1:shortCode
    R-->>A: Key absent (MISS)
    A->>P: findByCode(shortCode)
    P->>DB: SELECT URL row
    DB-->>P: URL row
    P-->>A: originalUrl
    A->>R: SET key originalUrl EX 300
    A-->>N: 302 Location: originalUrl
    N-->>C: 302 redirect
```

### Redirect request, cache hit

```mermaid
sequenceDiagram
    participant C as Client
    participant N as Nginx
    participant A as One API replica
    participant R as Redis

    C->>N: GET /shortCode
    N->>A: Proxy request
    A->>R: GET url:redirect:v1:shortCode
    R-->>A: originalUrl (HIT)
    A-->>N: 302 Location: originalUrl
    N-->>C: 302 redirect
```

### Responsibility boundaries

- **Controller:** HTTP request/response, status codes, and redirect response.
- **Service:** application behavior, including URL resolution and cache-aside coordination.
- **Repository:** Prisma/PostgreSQL operations.
- **Redis module:** creates and exposes the Redis client.
- **Nginx:** routes incoming HTTP requests to API replicas.
- **Docker Compose:** runs the local services and defines their internal network.

## 6. Repository structure

The layout below reflects the files and folders introduced or shown during the project. Generated `dist/` and `node_modules/` directories are omitted from the tree because they are build/runtime artifacts.

```text
URL_Shortener_Not_Just_Your_Regular_One/
├── src/
│   ├── config/
│   │   └── env.ts
│   ├── controllers/
│   │   ├── auth.controller.ts
│   │   ├── experiment.controller.ts
│   │   └── url.controller.ts
│   ├── db/
│   │   ├── prisma.ts
│   │   └── redis.ts
│   ├── experiments/
│   │   ├── in-memory-counter.ts
│   │   └── url-resolution-baseline.ts
│   ├── lib/
│   │   └── jwt.ts
│   ├── middleware/
│   │   └── auth.middleware.ts
│   ├── repositories/
│   │   ├── url.repository.ts
│   │   └── user.repository.ts
│   ├── routes/
│   │   ├── auth.routes.ts
│   │   ├── experiment.routes.ts
│   │   └── url.routes.ts
│   ├── services/
│   │   ├── auth.service.ts
│   │   ├── shared-counter.service.ts
│   │   └── url.service.ts
│   ├── utils/
│   │   └── generateCode.ts
│   └── server.ts
├── prisma/
│   ├── migrations/
│   └── schema.prisma
├── scripts/
│   └── benchmarks/
│       └── diagnose-whoami.cjs
├── nginx/
│   └── nginx.conf
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env                 # local secret values; do not commit
├── .env.example         # safe template; no real credentials
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── dist/                # generated JavaScript; created by tsc
└── README.md
```

If your current local tree differs slightly, prefer the actual filenames in your repository. Throughout development, `generateCode.ts` was imported in compiled ESM source with the `.js` extension (`../utils/generateCode.js`), which is normal when TypeScript emits JavaScript ESM.

## 7. Prerequisites

### Native development

- Windows PowerShell.
- Node.js and npm.
- A Neon PostgreSQL database and valid connection strings.
- Git and an editor such as Visual Studio Code.

### Containerized experiments

- Docker Desktop for Windows.
- WSL 2 backend configured and running.
- Docker CLI and Docker Compose plugin.
- Hardware virtualization enabled.

Docker was installed and verified with `docker --version`, `docker compose version`, and `docker run hello-world` before this application was containerized.

## 8. Configuration and secrets

Create a local `.env` file from `.env.example`. Never paste a real database URL, JWT secret, or password into this README.

Example template — replace placeholders locally:

```dotenv
# Neon PostgreSQL. Use the pooled URL for the runtime connection as appropriate
# for your Neon configuration.
DATABASE_URL="postgresql://USER:PASSWORD@YOUR-NEON-POOLER-HOST/neondb?sslmode=require"

# Direct connection URL for Prisma operations that require a direct database connection.
DIRECT_URL="postgresql://USER:PASSWORD@YOUR-NEON-DIRECT-HOST/neondb?sslmode=require"

PORT=3000
JWT_SECRET="REPLACE_WITH_A_LONG_RANDOM_SECRET"

# Used to construct returned short URLs. Compose overrides this for its API services.
PUBLIC_BASE_URL="http://localhost:3000"

# Optional when running natively. Docker Compose injects redis://redis:6379 into API containers.
# REDIS_URL=
```

The schema uses `DATABASE_URL` and `DIRECT_URL`. The application configuration also reads the port, JWT secret, public base URL, and optional Redis URL.

### Secret handling

- `.env` must remain in `.gitignore` and `.dockerignore`.
- The Docker image must not `COPY .env`.
- Compose uses `env_file: .env` to inject environment values into each API container at runtime, and service-specific `environment` values override them.
- Use `.env.example` only for placeholders.
- A Neon connection string containing credentials was accidentally shared during the learning conversation. **Rotate the Neon database password/connection credentials before treating this as anything beyond a local learning environment.** Do not put the leaked connection string in Git history or this README.

## 9. Local setup and commands

Run commands from the project root unless specified otherwise.

### Install dependencies

```powershell
npm install
```

### Compile TypeScript

```powershell
npm run build
```

The configured build script runs `tsc -b`. It emits compiled JavaScript into `dist/`.

### Run natively

The development/run script used during the project compiles and starts the compiled file:

```powershell
npm run dev
```

The application was also restarted and exercised with:

```powershell
npm start
```

Check the scripts in your current `package.json` if you need to confirm the exact local behavior; don't replace the established compiled-JavaScript workflow with a TypeScript runtime unless you deliberately want to change it.

### Prisma commands

```powershell
npx prisma generate
npx prisma studio
```

`prisma generate` generates Prisma Client from `schema.prisma`. `prisma studio` opens a visual browser for inspecting records.

For schema evolution, use migration files and `prisma migrate dev` after resolving any existing migration-history drift. See [Errors encountered](#21-errors-encountered-and-what-they-taught-us).

### Start the Docker stack

```powershell
docker compose config
docker compose build api1
docker compose up -d --build
docker compose ps
```

Expected services:

- `api1`
- `api2`
- `api3`
- `nginx`
- `redis`

Check logs:

```powershell
docker compose logs --tail=100 nginx api1 api2 api3 redis
```

Follow logs interactively:

```powershell
docker compose logs -f
```

Stop the stack (containers/network are removed; your source code and remote Neon database remain):

```powershell
docker compose down
```

`docker compose stop redis` stops only Redis; `docker compose start redis` starts that service again. `docker compose stop api2` is the command used for the API failure experiment.

### Check Redis

```powershell
docker compose exec redis redis-cli PING
docker compose exec redis redis-cli EXISTS "url:redirect:v1:AHFCKI"
docker compose exec redis redis-cli TTL "url:redirect:v1:AHFCKI"
```

Expected `PING` result when healthy:

```text
PONG
```

`EXISTS` returns `1` if a cache key exists and `0` otherwise. `TTL` returns the remaining number of seconds for a key with an expiry. Do not use `FLUSHALL` or `FLUSHDB` to reset the experiment; delete only the known test key when needed:

```powershell
docker compose exec redis redis-cli DEL lab:shared-counter:v1
```

## 10. API reference

The public entry point for the Compose stack is `http://localhost:8080` through Nginx. The API containers listen internally on port `3000`.

| Method | Path | Auth? | Purpose | Expected successful response |
|---|---|---:|---|---|
| `GET` | `/` | No | Basic service response | `200` JSON |
| `GET` | `/health` | No | Health endpoint | `200` JSON |
| `POST` | `/api/auth/register` | No | Create a user and return a token | `201` JSON |
| `POST` | `/api/auth/login` | No | Verify credentials and return a token | `200` JSON |
| `POST` | `/api/urls` | Yes | Create a short URL for the authenticated user | `201` JSON |
| `GET` | `/api/urls` | Yes | List URLs owned by the authenticated user | `200` JSON |
| `GET` | `/:code` | No | Resolve a short code and redirect | `302` |
| `GET` | `/whoami` | No | Return instance ID and process ID for scaling diagnostics | `200` JSON |
| `GET` | `/debug/local-counter` | No | Increment process-local counter | `200` JSON |
| `GET` | `/debug/shared-counter` | No | Atomically increment Redis shared counter | `200` JSON when Redis is available; otherwise `503` |
| `GET` | `/debug/redirect-baseline/:code` | No | Resolve a URL directly through PostgreSQL for benchmarking | `302` for a known code when DB is reachable |

**Important:** the debug routes are for local learning and benchmarking. They should not be publicly exposed as-is in a production deployment.

### Register

PowerShell example:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:8080/api/auth/register" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"email":"alice@example.com","password":"use-a-local-test-password"}'
```

The actual response contains a user summary and JWT. Do not store passwords as plaintext or commit test credentials.

### Login

```powershell
$login = Invoke-RestMethod `
  -Uri "http://localhost:8080/api/auth/login" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"email":"alice@example.com","password":"use-the-same-test-password"}'

$token = $login.token
```

### Create a short URL

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:8080/api/urls" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body '{"url":"https://www.youtube.com"}'
```

The request body in the current controller uses the property `url`; the service stores it as `originalUrl`. The returned `shortUrl` uses `PUBLIC_BASE_URL`, configured as `http://localhost:8080` in the containerized API services.

### List the current user's URLs

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:8080/api/urls" `
  -Method GET `
  -Headers @{ Authorization = "Bearer $token" }
```

The auth middleware reads the bearer token and puts the verified user ID on the request. The list query filters with that user ID.

### Test a public redirect without following it

Use `curl.exe` (not PowerShell's `curl` alias) to see the response code without following `Location`:

```powershell
curl.exe -s -o NUL -w "HTTP %{http_code}`n" "http://localhost:8080/AHFCKI"
```

For an existing code, `302` is the expected response. Autocannon's “non 2xx responses” count includes these expected 3xx redirects; it is not an error count by itself.

## 11. Data model

The Prisma schema contains `User` and `Url` models.

### User

| Field | Purpose |
|---|---|
| `id` | Auto-incrementing primary key |
| `email` | Unique user identity |
| `password` | Password hash produced by `bcryptjs` |
| `createdAt` | Creation timestamp |
| `urls` | One-to-many relation to owned URLs |

### Url

| Field | Purpose |
|---|---|
| `id` | Auto-incrementing primary key |
| `code` | Unique short code |
| `originalUrl` | Destination URL |
| `createdAt` | Creation timestamp |
| `expiresAt` | Optional expiration timestamp field in the schema |
| `clickCount` | Integer field defaulting to zero |
| `userId` | Required foreign key to `User` |
| `user` | Relation to the owning user; deletes cascade from user to URL |

The schema has an index on `userId`. The `expiresAt` and `clickCount` columns exist, but the redirect path shown in this experiment does not implement a full expiration policy or increment click counts. A declared column is not the same thing as implemented behavior.

### Persistence flow

```text
URL Controller
  -> URL Service
    -> URL Repository
      -> Prisma Client
        -> Neon PostgreSQL
```

The repository's `findByCode(code)` currently uses `prisma.url.findUnique({ where: { code } })`. `createUrl(...)` creates a row with `code`, `originalUrl`, and `userId`. `findByUserId(userId)` returns only the authenticated user's records sorted by `createdAt` descending.

## 12. Authentication and ownership

### Registration flow

```text
email + password
       |
       v
Auth Service
       |
       +--> check for existing email
       |
       +--> bcryptjs.hash(password, 12)
       |
       v
User Repository -> PostgreSQL
       |
       v
JWT signed with configured secret
```

### Login flow

```text
email + password
       |
       v
find user by email
       |
       v
bcryptjs.compare(plain password, stored hash)
       |
       v
create JWT
```

The code uses a generic invalid-credentials error when the email is absent or the password doesn't match. The JWT helper signs the `userId` claim and verifies the token in middleware.

### Protected request

```text
Authorization: Bearer <JWT>
           |
           v
Auth Middleware -> verify token -> req.userId
           |
           v
URL Controller -> URL Service -> URL Repository
```

The URL create path requires `req.userId`; the repository creates the URL with that user ID. The list route queries by the same user ID. Public redirect resolution does not require authentication.

This is a learning implementation. Production use should add stronger input validation, request throttling, a deliberate JWT-secret lifecycle, safe error responses, and dedicated automated tests.

## 13. Docker implementation

### Why a Dockerfile?

The host's `node_modules` and build output are not copied into the image. Docker installs dependencies and compiles the TypeScript in a controlled build environment, then runs the compiled JavaScript in the final image.

The Dockerfile uses Node 22 Bookworm slim and a two-stage build:

```text
Build stage
  - copy package manifests
  - npm ci
  - copy tsconfig.json, prisma/, src/
  - prisma generate
  - npm run build (tsc -b)
           |
           v
Production stage
  - install production dependencies
  - copy dist/
  - copy generated Prisma runtime artifacts
  - CMD node dist/server.js
```

The observed build also installs OpenSSL in the image, needed by the Prisma runtime in this setup. The final image exposes port `3000` inside the container.

### Why `.dockerignore`?

The project ignores at least:

```text
node_modules
dist
.git
.gitignore
.env
.env.*
*.tsbuildinfo
README.md
```

The exact current file should be checked in the repository. The important principles are to avoid sending host-generated dependencies/build outputs into Docker's build context and never baking secrets into the image.

### Compose topology

- `api1` builds `url-shortener:local` from the Dockerfile.
- `api2` and `api3` reuse the same image.
- All API containers listen on container port `3000` and receive unique `INSTANCE_ID` values.
- All API containers receive `PUBLIC_BASE_URL=http://localhost:8080` and `REDIS_URL=redis://redis:6379` through Compose environment configuration.
- The `redis` service uses `redis:7-alpine` and a `redis-cli ping` health check.
- `nginx` uses `nginx:alpine`, mounts `./nginx/nginx.conf` read-only, and publishes host port `8080` to container port `80`.
- Redis's port `6379` is not published to the host; the API containers reach it through Compose DNS.

### Docker networking: `localhost` is relative

From Windows, `localhost:8080` means the host's published port. Inside an API container, `localhost` refers to that same container, not another service.

Thus this is the Compose-network URL:

```text
redis://redis:6379
```

`redis` is the Compose service name. It is not an Upstash URL and it is not an imitation of Redis: it connects to the real Redis server running locally in a container.

## 14. Horizontal scaling and Nginx

### Current load-balancer config

The Nginx config defines an upstream group using the Compose service names:

```nginx
upstream url_shortener_backend {
    server api1:3000;
    server api2:3000;
    server api3:3000;
}
```

Requests sent to host port `8080` are proxied to that upstream group. With equal weights, Nginx's default upstream selection is round-robin.

### How we verified it

The `/whoami` endpoint returns:

```json
{
  "instance": "api-2",
  "pid": 1
}
```

The observed 12-request sequence after restarting Nginx was:

```text
api-1, api-2, api-3,
api-1, api-2, api-3,
api-1, api-2, api-3,
api-1, api-2, api-3
```

Each container reported PID `1`; that is normal because each container has its own PID namespace. `INSTANCE_ID`, rather than the numeric PID, identifies the replica.

### Stop one API instance

```powershell
docker compose stop api2
```

In the observed sequential test, requests continued successfully through API 1 and API 3. After starting API 2 again, it returned to rotation after a wait. At another point, restarting Nginx immediately restored all three instances after API 1 was missing from requests following a container rebuild.

### Routing/recovery caveat

We did not definitively isolate why one replica was temporarily absent after restarts. Possible factors include Nginx's passive upstream failure state and how its static upstream hostnames resolve when API containers are recreated. Restarting Nginx restored rotation in one test, and waiting about 12 seconds after restarting API 2 allowed it to receive requests again. Treat this as a finding to revisit, not a proven root cause.

The current configuration does not implement a separate active health-check controller. Docker Compose `depends_on` controls service startup ordering/conditions but is not a complete guarantee that every application is ready for traffic. Improved upstream discovery/recovery is a future task.

### What this demonstrates — and what it doesn't

It demonstrates multi-process/container routing and some tolerance of one API instance being stopped. It does **not** demonstrate resilience to physical-host failure, because all API replicas run on the same laptop. Nor does three replicas guarantee three times the throughput: they share CPU, memory, Nginx, Redis, and the same remote database.

## 15. Process-local state experiment

File: `src/experiments/in-memory-counter.ts`

The experiment starts with a process-local variable:

```typescript
let counter = 0;
```

The endpoint `/debug/local-counter` increments it and returns the instance ID, process ID, counter value, and a storage label.

Example observed sequence:

```text
api-2 counter=1
api-3 counter=1
api-1 counter=2  # API 1 had already received one request before the loop
api-2 counter=2
api-3 counter=2
api-1 counter=3
...
```

The first API 1 value in that loop was `2`, rather than `1`, because a separate request had already incremented that process's counter.

**Lesson:** a global variable in a code file is not a global variable across three Node.js processes. Each process loads its own copy of the module. This matters for process-local sessions, rate limits, counters, and other state that must be consistent across replicas.

## 16. Redis shared-state experiment

Redis was introduced as a real local Redis server using the `redis:7-alpine` Docker image. The official Node Redis package connects from each API container to `redis://redis:6379`.

Files involved:

- `src/db/redis.ts`
- `src/services/shared-counter.service.ts`
- `src/controllers/experiment.controller.ts`
- `src/routes/experiment.routes.ts`

The shared counter uses the Redis key:

```text
lab:shared-counter:v1
```

The service increments it using Redis `INCR`, an atomic integer-increment operation. Different API replicas receive the next value from the same shared key.

### Observed behavior

After deleting the key when it did not exist, `redis-cli DEL` returned `0`. The next 12 requests returned values `1` through `12`, handled by API 2, API 3, and then subsequent replicas. This confirmed that the value was not local to an API process.

Later, when API 2 was stopped, API 1 and API 3 served requests and the shared counter progressed from `25` to `33`. After API 2 started and the upstream recovered, requests from all three instances continued the sequence through `51` and later through `66`.

### What Redis means here

This is **local Redis**, not Upstash. The Redis process itself runs in Docker on the same computer. Each API connects to that one Redis service through the Compose network. The shared state is genuinely stored in Redis; it is not a custom in-memory Redis clone.

There is no Compose volume explicitly configured for Redis data in this lab. Do not assume counter/cache data is durable across container removal or recreation. Redis is used here for a shared fast data store, while Neon PostgreSQL remains the durable URL/user database.

## 17. Redis cache-aside implementation

### Purpose

Repeated redirects were expensive because the service queried the remote Neon PostgreSQL database for every code. The cache-aside pattern checks Redis first and queries PostgreSQL only on a cache miss.

Files involved:

- `src/services/url.service.ts`
- `src/repositories/url.repository.ts`
- `src/experiments/url-resolution-baseline.ts`
- `src/db/redis.ts`
- `src/controllers/experiment.controller.ts`
- `src/routes/experiment.routes.ts`

### Cache key and TTL

```text
url:redirect:v1:<shortCode>
```

For example:

```text
url:redirect:v1:AHFCKI
```

The configured TTL is `300` seconds (five minutes). Redis `EXISTS` returned `1` for the tested key, and `TTL` later returned `252` and then `251`, consistent with the entry being within its five-minute expiry window.

### Cache-aside request flow

1. `resolveUrl(code)` constructs the versioned cache key.
2. If the Redis client is ready, it attempts `GET`.
3. On a cache hit, it logs (when debug logging is enabled) and returns the cached destination.
4. On a cache miss, it calls the existing `findByCode(code)` repository method, which queries PostgreSQL through Prisma.
5. If a URL row exists, it stores `originalUrl` in Redis with `EX 300`.
6. It returns the destination to the controller, which sends the HTTP `302` redirect.
7. A missing URL currently returns `null`; the implementation deliberately does not cache negative/404 results.

### Cache failure behavior

- If Redis is not ready, the service bypasses the cache and goes to PostgreSQL.
- If a cache read fails, it warns and attempts PostgreSQL.
- If Redis cannot store the result after PostgreSQL succeeds, it warns and returns the database result.
- If PostgreSQL is unreachable on a cache miss, the redirect can still fail. Redis fallback cannot manufacture a URL that is neither cached nor retrievable from PostgreSQL.

There is an implementation nuance: the server startup currently attempts a Redis connection when `REDIS_URL` is configured. If that initial connection fails, the startup promise catches the error and exits. We tested Redis stopping **after the API processes were already running**; the successful fallback result does not prove that fresh API containers can start while Redis remains offline.

### Original PostgreSQL-only implementation preserved

The original resolver remains available at `src/experiments/url-resolution-baseline.ts` and is exposed by the benchmark-only path:

```text
/debug/redirect-baseline/:code
```

It always goes through `findByCode()` and bypasses Redis. This makes it possible to compare the two resolution paths without deleting the previous implementation.

## 18. Failure and recovery experiments

### Experiment A — One API replica stopped

Command:

```powershell
docker compose stop api2
```

Twelve sequential `/whoami` requests succeeded through API 1 and API 3. Later, after API 2 was restarted and the upstream recovered, all three instances appeared again. This is an instance-level failure exercise, not a multi-machine failover test.

### Experiment B — Shared counter during API failure

With API 2 stopped, nine requests returned values `25` through `33` from API 1 and API 3. After API 2 was started, the counter continued from `34` onwards. State wasn't reset per API, proving Redis remained the shared state store.

### Experiment C — Redis stopped while APIs continued running

Commands:

```powershell
docker compose stop redis
# Run redirect requests

docker compose start redis
Start-Sleep -Seconds 5
docker compose exec redis redis-cli PING
```

The three redirect requests sent while Redis was stopped all returned HTTP `302`. After the service was started again, `PING` returned `PONG` and a subsequent redirect again returned `302`. The cache key was present afterward with a positive TTL.

This is evidence that a running API can fall back to PostgreSQL while Redis is unavailable, assuming PostgreSQL is reachable. Since the key was checked after a redirect request, the `EXISTS` result alone doesn't prove whether Redis preserved the key during the stop or whether that request repopulated it.

## 19. Benchmark methodology

### Tool

Autocannon was invoked via `npx autocannon` initially; its output identified `autocannon@8.0.0`. The first `npx` invocation prompted for package installation and emitted a deprecated `uuid@8.3.2` warning. A diagnostic Node script was later added at `scripts/benchmarks/diagnose-whoami.cjs` after installing Autocannon as a development dependency.

### Main settings

The usual command format was:

```powershell
npx autocannon -c 20 -d 10 http://localhost:3000/health
```

- `-c` is concurrent connections.
- `-d` is test duration in seconds.
- Tests were run against `/health`, `/whoami`, the direct short-code redirect, and the database-only redirect benchmark path.

### Response codes

URL redirect endpoints return HTTP `302`. Autocannon reports 2xx responses separately from non-2xx responses. Consequently:

```text
0 2xx responses, many non 2xx responses
```

is compatible with successful `302` redirects. The status itself must be inspected to tell a redirect from a genuine `4xx` or `5xx` response.

Nginx `499` means the client closed the connection before the response completed. It may be associated with requests cancelled or still pending during load testing, but the code alone does not prove the exact root cause. Autocannon separately reported `ECONNRESET` client errors in some tests.

### Fair-comparison caveats

- Neon is remote; database connection and query latency vary over time.
- Some baseline runs had Prisma errors saying Neon could not be reached.
- Cached runs occasionally reported Autocannon `ECONNRESET` errors.
- Host CPU/memory were shared across API containers, Nginx, Redis, and the benchmark process.
- Tests were not run repeatedly under a fully controlled environment, and the machine's resource utilization wasn't captured as a time series.
- Some Nginx log queries included a rolling ten-minute window that contained requests from more than one benchmark.

Therefore the figures below are **observed lab results**, not formal capacity promises or a production load-test report.

## 20. Benchmark results

The numbers in this section are transcribed from the actual runs recorded during the experiment. Different runs are not perfectly comparable because the tests were done at different times and, in some cases, had connectivity/client errors.

### A. Native Windows process — `/health`

After fixing route order so that `/health` was not captured by the generic `/:code` route:

| Metric | Observed result |
|---|---:|
| Concurrency | 20 |
| Average throughput | 29,103.28 req/s |
| Average latency | 0.05 ms |
| P50 | 0 ms (rounded by tool) |
| P97.5 / P99 | 1 ms / 1 ms |
| Max latency | 19 ms |
| Total reported requests | ~320k in 11.02 seconds |

This is a lightweight response that doesn't touch PostgreSQL. It is one observed result, not a stable guaranteed rate.

### B. Native Windows process — redirect through PostgreSQL

| Concurrency | Average req/s | Average latency | P50 | P97.5 | P99 | Max latency |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 51.0 | 389.91 ms | 311 ms | 833 ms | 1,097 ms | 1,191 ms |
| 100 | 40.71 | 2,049.33 ms | 1,913 ms | 3,387 ms | 3,396 ms | 3,401 ms |
| 200 | 30.6 | 4,137.82 ms | 3,661 ms | 7,118 ms | 7,121 ms | 7,426 ms |

As concurrency increased from 20 to 200, average latency increased dramatically and the reported throughput fell. The remote database path was a likely contributor, but the test did not isolate every possible bottleneck.

### C. Single Docker API — `/health`

| Concurrency | Average req/s | Average latency | P50 | P97.5 | P99 | Max latency |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 6,624 | 2.52 ms | 2 ms | 6 ms | 7 ms | 93 ms |
| 100 | 6,488.4 | 14.91 ms | 13 ms | 28 ms | 33 ms | 672 ms |

Throughput stayed in a similar range, while latency grew at higher concurrency. Docker and host overhead make this different from the native run; these tests aren't a direct apples-to-apples runtime microbenchmark because they were separate trials and environments.

### D. Single Docker API — PostgreSQL redirect

| Concurrency | Average req/s | Average latency | P50 | P97.5 | P99 | Max latency |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 40.0 | 491.2 ms | 397 ms | 2,279 ms | 2,451 ms | 2,482 ms |
| 100 | 46.6 | 1,929.37 ms | 2,002 ms | 2,399 ms | 2,605 ms | 2,606 ms |

### E. Three API containers + Nginx

`/health`:

| Concurrency | Average req/s | Average latency | P50 | P97.5 | P99 | Max latency | Additional observations |
|---:|---:|---:|---:|---:|---:|---:|---|
| 20 | 3,997.6 | 7.09 ms | 7 ms | 15 ms | 18 ms | 60 ms | 27 errors, no timeouts |
| 100 | 5,256.5 | 18.63 ms | 14 ms | 60 ms | 160 ms | 429 ms | ~53k requests; separate run |

PostgreSQL-backed redirects:

| Concurrency | Average req/s | Average latency | P50 | P97.5 | P99 | Max latency |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 45.3 | 438.91 ms | 256 ms | 4,014 ms | 4,168 ms | 4,620 ms |
| 100 | 132.31 | 733.42 ms | 662 ms | 1,249 ms | 1,502 ms | 3,430 ms |

At 100 concurrent connections, the three-replica run had higher observed throughput and lower latency than the earlier one-container run. Because runs weren't perfectly controlled and database/network conditions varied, treat this as a promising observation rather than proof of a specific horizontal-scaling multiplier.

### F. API instance identification — `/whoami`

With API 2 stopped:

| Metric | Observed result |
|---|---:|
| Concurrency / duration | 20 / 10 seconds |
| Average req/s | 3,582.2 |
| Average latency | 7.53 ms |
| P50 / P97.5 / P99 | 6 / 20 / 26 ms |
| Max latency | 3,121 ms |
| Errors / timeouts | 9 / 0 |

With all three APIs running in another run:

| Metric | Observed result |
|---|---:|
| Average req/s | 4,507.5 |
| Average latency | 6.55 ms |
| P50 / P97.5 / P99 | 6 / 16 / 19 ms |
| Max latency | 75 ms |
| Errors / timeouts | 19 / 0 |

A later run with all APIs running reported 4,185.9 req/s, 7.18 ms average latency, and 18 errors. A diagnostic script recorded other runs with 50,728, 26,562, and 24,136 successful HTTP 200 responses plus 25, 20, and 9 `ECONNRESET` errors respectively. The results varied, which is why the resets remain a known diagnostic issue rather than a solved problem.

### G. Redis cache-aside vs PostgreSQL-only redirect

Both test endpoints return `302` on successful lookups. The database-only endpoint is `/debug/redirect-baseline/AHFCKI`; the regular redirect endpoint is `/AHFCKI`. The cache key is expected to be warm for the cached tests.

#### First comparison: 20 connections, 10 seconds

| Metric | PostgreSQL-only baseline | Redis warm cache |
|---|---:|---:|
| Average req/s | 39.1 | 3,785.2 |
| Average latency | 497.81 ms | 6.77 ms |
| P50 | 319 ms | 6 ms |
| P97.5 | 2,552 ms | 13 ms |
| P99 | 4,190 ms | 15 ms |
| Max latency | 4,193 ms | 898 ms |
| Reported errors | not separately reported in that summary | 12, zero timeouts |

The ratio of the two reported average throughput values is about **96.8×**, and average latency is about **98.6% lower** in the cached run. The cache run still had 12 client errors.

#### Repeat comparison: 5 connections, 10 seconds

| Metric | PostgreSQL-only baseline | Redis warm cache |
|---|---:|---:|
| Average req/s | 15.2 | 3,310.8 |
| Average latency | 329.81 ms | 5.08 ms |
| P50 | 315 ms | 5 ms |
| P97.5 | 592 ms | 10 ms |
| P99 | 705 ms | 11 ms |
| Max latency | 725 ms | 22 ms |
| Approx. requests shown | 157 | ~33k |
| Reported errors | no separate error line in displayed baseline output | 17, zero timeouts |

The ratio of reported average throughput values is about **217.8×**, and the mean latency reduction is about **98.46%** for this particular pair of runs. The cached run reported 17 errors and the baseline path had previously shown intermittent Prisma connectivity failures, so this multiplier is preliminary. It should not be presented as a guaranteed production result.

### HTTP status audit from Nginx logs

One selected ten-minute log window showed:

| Path | Status | Count |
|---|---:|---:|
| `/AHFCKI` | 302 | 37,865 |
| `/AHFCKI` | 499 | 3 |
| `/debug/redirect-baseline/AHFCKI` | 302 | 392 |
| `/debug/redirect-baseline/AHFCKI` | 499 | 20 |
| `/debug/redirect-baseline/AHFCKI` | 500 | 1 |

This window included traffic from multiple attempts rather than a clean isolated benchmark. It confirmed that many non-2xx responses were expected redirects and that some requests ended as `499`; a baseline `500` was also observed during a period when Prisma couldn't reach Neon.

### Benchmark conclusion

The cached endpoint was consistently orders of magnitude faster in the observed tests, which makes sense because it avoids the remote DB lookup on a cache hit. The precise multiplier varied from about 97× to 218× between runs. **Keep those values as measurements from this lab, not as an SLA, maximum capacity, or production benchmark.**

## 21. Errors encountered and what they taught us

This section records the major issues from the implementation process. Some were fixed; others remain known limitations.

### 21.1 Prisma migration drift after `db push`

**Observed behavior:** after running `npx prisma db push`, the subsequent `npx prisma migrate dev --name init_schema` reported drift. Prisma described `Url` and `User` as tables present in the database but not represented by the expected migration history, and showed indexes and a foreign key as schema differences. It proposed resetting the public schema, which would have deleted data.

**Why it happened:** `db push` changed the actual database schema without creating the corresponding migration-history entry. The database and the migrations directory then disagreed about how the schema had been reached.

**Lesson/fix direction:** avoid reflexively running `prisma migrate reset` against a database containing data you want to keep. The user later confirmed that the migration issue was resolved and continued the project; the exact corrective commands were not preserved in the conversation available for this README. For future work, use `prisma migrate dev --name ...` for schema evolution and retain migration files; use `db push` mainly when you intentionally choose a prototyping workflow.

### 21.2 Prisma create error: required `user` relation missing

**Observed TypeScript error:** a `prisma.url.create({ data: { code, originalUrl } })` call wasn't valid because the generated Prisma type required `user`/`userId`.

**Why it happened:** the Prisma schema made `Url.user` a required relation, but the creation call didn't supply the required owner.

**Temporary learning fix:** the relation was initially made optional (`userId Int?`, `user User?`) while authentication wasn't wired into URL creation. This allowed ownerless test URLs.

**Final intended model:** every URL is owned by a user, so the relationship was made required again. There was only one URL record and no User records at that point; the old ownerless test URL was deleted before applying the required relation migration. That avoided making the relation non-null while a row still had `userId = NULL`.

**Lesson:** the database schema, Prisma-generated input types, and actual service/repository arguments must agree about whether a relationship is optional.

### 21.3 Express `req.params.code` TypeScript error

**Observed error:**

```text
Argument of type 'string | string[] | undefined' is not assignable to parameter of type 'string'.
```

**Why it happened:** Express's route-param type doesn't guarantee a parameter is always present and represented as a single string.

**Fix:** explicitly narrowed the value before calling the resolver:

```typescript
const { code } = req.params;

if (typeof code !== "string") {
  return res.status(400).json({ error: "Invalid short code" });
}

const originalUrl = await resolveUrl(code);
```

**Lesson:** don't silence types using `as string` when runtime validation is appropriate. A type guard both satisfies the compiler and validates the value.

### 21.4 `/health` was being treated as a short code

**Observed behavior:** `Invoke-RestMethod http://localhost:3000/health` returned `{ "error": "URL not found" }`. Autocannon reported zero 2xx responses and only non-2xx responses for what was meant to be the health endpoint.

**Why it happened:** the generic dynamic route `/:code` could match `/health` if URL routes were registered before the explicit `/health` handler.

**Fix:** register specific routes such as `/`, `/health`, `/whoami`, and experiment routes before mounting the general URL router. The corrected `/health` benchmark on the native process then returned 2xx responses and reported around 29k req/s in one run.

**Lesson:** specific routes need to be registered before a broadly matching dynamic route such as `/:code` when using this router order.

### 21.5 Docker and WSL installation

Docker hadn't been used before this project. We first checked WSL 2 and virtualization, installed Docker Desktop with the WSL 2 backend, and verified Docker CLI, Compose, and `hello-world` before adding project files.

**Lesson:** verify the container runtime independently before diagnosing application/container errors.

### 21.6 Redis hostname confusion avoided

The Redis URL wasn't placed in `.env` for the Docker setup because Compose injects `REDIS_URL=redis://redis:6379` into each API container. The `redis` hostname resolves to the Compose service. `localhost` from inside an API container would refer to the API container itself, not Redis.

**Lesson:** container networking names and hostnames are relative to the network namespace.

### 21.7 Nginx stopped sending requests to one API temporarily

After rebuilding/recreating API containers, `/whoami` initially cycled through only API 2 and API 3. Restarting Nginx restored the full `api-1 -> api-2 -> api-3` cycle. In a later test, API 2 returned to the rotation after it was started and we waited about 12 seconds without restarting Nginx.

**Possible explanations:** passive upstream failure handling or stale hostname-to-IP resolution when containers are recreated. The available evidence does not conclusively establish the root cause.

**Lesson:** a container saying `Up` does not prove the reverse proxy is currently routing requests to it. Test the actual request path and inspect proxy logs.

### 21.8 Intermittent Neon/Prisma connectivity failure

**Observed Prisma error:**

```text
PrismaClientInitializationError
Can't reach database server at <Neon-pooler-host>:5432
```

This occurred in the database-only redirect baseline and caused the endpoint to return `500` for one request. Subsequent requests returned `302`.

A test from inside `api2` successfully resolved the Neon hostname and opened TCP port `5432`:

```text
DNS OK: <resolved IP>
TCP 5432 OK: connected
```

That test confirmed basic DNS/TCP reachability at that moment; it did not validate Prisma authentication, TLS, connection-pool behavior, or successful SQL queries. The transient failure's root cause wasn't conclusively found.

**Lesson:** a successful TCP connect is a useful diagnostic, but it isn't proof that the complete database handshake and query will succeed.

### 21.9 Autocannon reports many “non 2xx responses” for redirects

Both the baseline and cached redirect endpoints normally return `302`. Autocannon separates 2xx from non-2xx responses, so a valid redirect contributes to the non-2xx count.

**Correct interpretation:** inspect actual response codes. Don't label every `non 2xx` result an error.

### 21.10 Nginx `499` responses and `ECONNRESET`

During load tests, Autocannon reported errors such as:

```text
Error: read ECONNRESET [ECONNRESET]
```

Runs recorded 25, 20, and 9 resets in different attempts while also completing tens of thousands of HTTP `200` responses on `/whoami`. Other cache benchmarks reported 12 and 17 errors. Nginx logs also included `499` statuses, meaning the client closed the connection before Nginx completed the response.

The container inspection showed all four core services running with zero restarts and `oomKilled=false`; filtered logs did not show obvious matching Nginx upstream failures or API exceptions during one diagnostic window.

**Status:** unresolved/deferred, by decision. The issue was intentionally parked so the learning project could continue. It should be investigated before any serious reliability claim or production deployment. Possible sources include client-side cancellation/connection resets, proxy behavior, and shared local resource/network pressure; the evidence collected here does not prove a single cause.

### 21.11 Redis fallback worked during a runtime outage

Redis was stopped while the API processes were already running. Three redirects continued to return `302` through PostgreSQL. Redis was then restarted and `PING` returned `PONG`.

**Important distinction:** the test verifies fallback for already-running API processes under the tested conditions. Because startup currently attempts to connect to Redis when configured, a brand-new API process started while Redis is unavailable may fail startup. The startup behavior should be hardened if Redis is intended to be truly optional at process boot.

### 21.12 Warning from `npx autocannon`

The first `npx autocannon` invocation downloaded `autocannon@8.0.0` and emitted a deprecation warning related to `uuid@8.3.2`. This was a transitive dependency warning, not an error from the URL-shortener service. Autocannon was later installed as a development dependency for a diagnostic benchmark script.

## 22. Troubleshooting guide

### `GET /health` returns `URL not found`

- Confirm that `/health` is registered before `app.use(urlRoutes)`.
- Confirm the running process/container uses the rebuilt JavaScript/image.
- Run `npm run build`, then rebuild and recreate the API containers.

### TypeScript reports `string | string[] | undefined`

- Validate `req.params.code` with `typeof code === "string"` before using it as a string.

### Prisma says it can't reach Neon

- Check the `DATABASE_URL`/`DIRECT_URL` values without printing secrets to logs/chat.
- Check whether the Neon project/compute is available and whether the correct pooled/direct endpoint is configured.
- Test DNS and TCP from inside the API container, but remember that this alone doesn't prove Prisma can perform a query.
- Inspect API logs for `PrismaClientInitializationError`.

### `prisma migrate dev` reports drift

- Don't blindly reset the schema if it contains records to preserve.
- Understand whether `db push` changed the schema outside migration history.
- Reconcile the migration history/schema before applying further migrations.

### Redis client isn't available

- `docker compose ps` should show Redis healthy.
- `docker compose exec redis redis-cli PING` should return `PONG`.
- Inside Compose, use `redis://redis:6379`, not `localhost:6379`.
- Inspect `docker compose logs --tail=100 redis api1 api2 api3`.

### Redis key doesn't exist

- Run the redirect once to warm the cache if PostgreSQL is reachable.
- Then check `EXISTS` and `TTL`.
- A cache miss after TTL expiry is expected; the service should query PostgreSQL and repopulate the entry.

### Nginx doesn't reach all instances

- Check `docker compose ps` and the `/whoami` endpoint.
- Inspect `docker compose logs --tail=100 nginx api1 api2 api3`.
- The experiment observed that an Nginx restart could restore round-robin rotation after API containers were recreated. Don't treat that workaround as a complete production fix; improve service discovery and health/recovery behavior later.

### Autocannon says `0 2xx responses`

- For a redirect route, check if responses are `302`; that's expected.
- For `/health` or `/whoami`, expect `200`. If they're counted as non-2xx, check route order and actual HTTP status codes.
- Inspect Nginx access logs and Autocannon `errors`/`timeouts` separately.

## 23. Security and production-readiness gaps

This project is a lab. Before exposing it publicly, address at least the following:

- **Secrets:** rotate the Neon credentials shared during development, keep secrets out of Git and Docker layers, and use a secret-management mechanism in real deployments.
- **Input validation:** validate the original URL with a URL parser and explicit scheme/hostname rules; validate email/password inputs and payload size.
- **Abuse protection:** rate-limit registration/login and URL creation; consider global/distributed rate limiting if there are multiple replicas (Redis can help with shared counters).
- **Redirect safety:** decide whether arbitrary schemes/hosts are allowed and consider abuse/phishing controls.
- **Auth hardening:** establish password policy, token lifetime/rotation strategy, safe error handling, and security tests. The code's current JWT expiry is set in the helper; ensure configuration/documentation agrees with implementation.
- **HTTP hardening:** add centralized error middleware, request IDs, structured logging, graceful shutdown, secure headers, and appropriate CORS configuration if a browser frontend is added.
- **Debug endpoints:** remove or protect `/whoami`, `/debug/local-counter`, `/debug/shared-counter`, and `/debug/redirect-baseline/:code` in a production build.
- **Cache consistency:** add invalidation when URLs are edited/deleted, choose a deliberate negative-cache policy, and document behavior when a URL expires. Current `expiresAt` exists in the schema, but expiry enforcement isn't implemented in the shown resolver.
- **Redis failure handling:** allow the API to start or remain available according to an explicit policy when Redis is unavailable; the current startup path attempts a Redis connection eagerly.
- **Redis persistence/HA:** configure persistence/volume/replication only if the use case requires it. Current Compose setup is for learning and doesn't provide production-grade Redis high availability.
- **Database resilience:** diagnose intermittent Neon connectivity, review pool sizes, timeouts, retry policies, and database connection limits before high-load usage.
- **Nginx:** improve health checking/service discovery/recovery and set deliberate proxy/connect/read timeouts.
- **Tests:** add unit/integration tests for auth, ownership, redirect behavior, cache hit/miss, Redis outage, and database outage.
- **Migrations:** maintain a trustworthy migration history and use a deployment-safe migration workflow.
- **Monitoring:** record request rates, status distributions, latency histograms, cache hit/miss rates, Redis errors, database errors, CPU and memory over time.
- **Benchmark quality:** warm up, repeat multiple runs, separate successes from failures, collect resource metrics, and run against controlled/consistent database conditions.

## 24. Lessons learned

### Persistence versus process memory

An in-memory map is simple, but its state is tied to one process. PostgreSQL is appropriate for durable URL/user records that must survive application restarts.

### Horizontal versus vertical scaling

Horizontal scaling adds application instances. Vertical scaling increases the resources available to an instance or host. Running three containers on a single laptop is useful to learn multi-instance behavior, but isn't the same thing as three independent servers. This particular project focused on horizontal scaling; it did not complete a controlled CPU/memory vertical-scaling benchmark.

### Load balancing isn't shared state

Nginx decides where a request goes. It doesn't make API process memory shared. Redis provided the shared counter store that the three independent processes could access.

### More instances aren't automatically faster

The three replicas shared the same machine and external dependencies. A lightweight health endpoint had different performance characteristics from a redirect endpoint that queried remote PostgreSQL. Nginx added its own work. Performance depends on the bottleneck, not just instance count.

### Cache-aside is an optimization, not the source of truth

PostgreSQL remains durable storage. Redis stores copies of lookups so warm redirects avoid repeated database reads. TTL bounds how long an unchanged cache entry lives, but cache invalidation and consistency are additional design decisions.

### Failover has to be tested, not assumed

Stopping API 2 showed that requests could continue through other replicas. Testing after API 2 restart also exposed a temporary routing-recovery issue. Those experiments were more informative than just drawing an architecture diagram.

### Measure the HTTP status, not only Autocannon's summary label

A `302` is the correct result for a redirect. A `499` is an Nginx client-closed status, a `500` is a server-side failure, and `ECONNRESET` is a transport error reported by the client. They mean different things and should not be counted interchangeably.

### The bottleneck can move

Caching reduced the need for a remote database lookup on a warm redirect. That makes Redis and the API path more central for warm-cache performance, and leaves cold misses dependent on PostgreSQL. At higher scale, Redis capacity, memory, network, database pool limits, and cache hit ratio all need measurement.

## 25. Future experiments

These are intentionally deferred so the project can be treated as a completed learning milestone without pretending every production concern is solved.

1. **Resolve `ECONNRESET` / Nginx 499 behavior.** Compare direct API routes with Nginx and record CPU/memory/socket behavior.
2. **Stabilize Neon connectivity.** Repeat database-backed tests while collecting Prisma/database errors and controlled connection measurements.
3. **Improve Nginx upstream re-discovery and health recovery.** Remove the need for a manual restart workaround after container recreation.
4. **Benchmark with warm-up and repetitions.** Run multiple trials for native, one-container, three-container, cold-cache, and warm-cache modes; calculate median and spread.
5. **Cache invalidation.** If URLs become editable/deletable, invalidate `url:redirect:v1:<code>` when the source record changes.
6. **Negative caching.** Consider whether to cache 404s, with a short TTL and a clear policy to avoid stale misses.
7. **Expiration enforcement.** Implement `expiresAt` checks and decide how expired entries interact with Redis TTL.
8. **Atomic click counts.** Decide whether click-count writes should go to PostgreSQL directly, be buffered, or use Redis plus a durable write path.
9. **Shared rate limiting.** Use Redis to demonstrate a global limit across API replicas.
10. **Redis persistence and outages.** Add a Redis volume only if persistence is part of the lab goal; separately test Redis container recreation and data loss.
11. **Production-grade health/readiness checks.** Distinguish process liveness, readiness to serve traffic, and dependency health.
12. **CI and automated testing.** Add a test suite to preserve the behavior learned in these experiments.
13. **Vertical-scaling lab.** Introduce controlled CPU-heavy work and compare resource limits/worker counts while keeping test load reproducible.
14. **Multiple physical hosts or a cloud deployment.** Only after local multi-instance concepts are stable.

## 26. Glossary

| Term | Meaning in this project |
|---|---|
| API instance / replica | One running copy of the Node.js backend. |
| Container | A running instance of a Docker image with its own process/network namespace. |
| Docker image | The built artifact from which API containers are created. |
| Docker Compose | Local configuration/orchestration for the API replicas, Nginx, and Redis. |
| Reverse proxy | Nginx receives external requests and forwards them to backend services. |
| Load balancer | The component that distributes incoming requests across API instances. |
| Round robin | A simple upstream selection policy that cycles among equally weighted servers. |
| Process-local state | Data held only in one Node.js process's memory. |
| Shared state | Data multiple API instances can access through a common system, here Redis. |
| Source of truth | The durable authoritative store for application records, here PostgreSQL. |
| Cache-aside | Application checks cache first, queries source of truth on miss, and fills cache. |
| Cache hit | Requested key/value is already available in Redis. |
| Cache miss | Requested key is absent; the application queries PostgreSQL. |
| TTL | Time to live; the duration before a cache key expires, here 300 seconds. |
| Prisma Client | Generated typed data-access library used to query PostgreSQL. |
| Migration drift | The real database schema differs from the state described by migration history. |
| P50 / P99 | 50th/99th percentile latency: median / tail latency under a test. |
| Throughput | Number of requests processed per unit of time, typically req/s. |
| `302` | HTTP redirect status expected from a valid short URL. |
| `404` | Resource/code not found. |
| `500` | Server-side failure; in the observed baseline case, Prisma couldn't reach Neon. |
| `499` | Nginx log status indicating the client closed the connection before completion. |
| `ECONNRESET` | A TCP connection was reset while the client was reading. It is not an HTTP status code. |
| Neon | Hosted PostgreSQL database used for durable data. |
| Upstash | A managed Redis service the developer has used elsewhere; this lab instead runs local Redis in Docker. |

---

## Final note

The most valuable output of this project is not just the URL shortener. It is the documented progression from local memory to persistent storage, authentication, containers, multiple replicas, shared state, caching, and failure experiments—along with the errors and uncertainty encountered along the way.

Keep the old baseline and experiment files while they remain educational. In future iterations, use Git commits and tagged milestones to preserve the history. When cleaning up for production, remove or protect diagnostic routes and replace experimental comments with version-controlled history and design notes.
