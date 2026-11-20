# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, object storage, queue broker) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

The `video-worker` service is the exception: it is a background consumer (no HTTP) and starts with `docker compose up -d` on its own (`npm run start:worker:dev`, `restart: unless-stopped`). On a fresh clone it restarts until `docker compose exec nestjs-api npm install` has populated `node_modules`.

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose ps minio` — expect `healthy` (healthcheck: `curl -f http://localhost:9000/minio/health/live`)
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started — consuming queue "video-processing"`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — video processing worker (`src/worker.ts`, same image/code as the API, no HTTP); consumes the `video-processing` BullMQ queue and runs `ffprobe`/`ffmpeg`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage (`pgsty/minio`, community build of MinIO), S3 API `9000`, console `9001`, credentials `streamtube` / `streamtube-secret`, bucket `streamtube` (created by the app on startup)
- `redis` — BullMQ broker (`redis:7.4-alpine`, AOF on, `noeviction`), reachable only inside the Compose network (no host port)

`Dockerfile.dev` installs `ffmpeg`, so `ffprobe`/`ffmpeg` exist in both `nestjs-api` and `video-worker`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker in watch mode (what the video-worker service runs; builds to dist-worker/)
npm run start:worker                     # Video worker from the compiled build (dist/worker.js)
npm run migration:run                    # Apply migrations (videos table: 1795153056068-CreateVideos)
npm run openapi:export                   # Regenerate openapi.json after changing an endpoint

npm test                                 # Unit + integration tests (serial: maxWorkers 1)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (serial: maxWorkers 1)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** run serially. Both Jest configs set `maxWorkers: 1` (`package.json` → `jest`, `test/jest-e2e.json`), so the plain commands are already serial; `--runInBand` is equivalent and harmless:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Video tests use the real Compose services (no mocks): MinIO, Redis and `ffmpeg`. Helpers in `src/test/`:

- `jest-setup-env.ts` — loaded after `dotenv/config`; sets `QUEUE_PREFIX=streamtube-test` so the running `video-worker` container (prefix `streamtube`) never consumes test jobs.
- `presigned-request.ts` — `presignedRequest()` / `uploadFileToParts()`: call client-facing presigned URLs (signed for `localhost:9000`) from inside the container by sending them to `minio:9000` with the original `Host` header.
- `video-fixture.ts` — generates real MP4/M4A fixtures with `ffmpeg -f lavfi` plus a deterministic corrupt file.
- `video-test-module.ts` — `createVideoTestingModule()` (Config + TypeORM + QueueModule) and `createChannelOwner()`.
- `test/helpers/e2e-app.ts` — `createE2eApp()`, `createConfirmedUser()`, `deleteStoredVideoObjects()`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share the code base: `src/main.ts` (HTTP API, `AppModule`) and `src/worker.ts` (video worker, `WorkerModule` via `createApplicationContext`). Root setup shared by both: `src/config/config-module.options.ts`, `src/database/database.module.ts`, `src/queue/queue.module.ts`.

### Videos (Phase 03)

Plan and decisions: `docs/phases/phase-03-videos/` and `docs/decisions/technical-decisions-phase-03-videos.md`.

| Module | Role |
|--------|------|
| `src/storage/` (`StorageModule`) | `StorageService` — only gateway to S3/MinIO: bucket ensure on init, multipart create/list/complete/abort, presigned part/GET URLs, head/put/delete. Two clients: `S3_ENDPOINT` for calls, `S3_PUBLIC_ENDPOINT` only for signing client URLs |
| `src/queue/` (`QueueModule`) | `BullModule.forRootAsync` from the `queue` config namespace (Redis host/port, `QUEUE_PREFIX`) |
| `src/videos/` (`VideosModule`, in `AppModule`) | `Video` entity (`videos` table, linked to `Channel`), `VideosService` (upload initiation/completion, read policy, playback URLs, worker state transitions), `VideoProcessingProducer`, `VideoPresenter`, `VideosController` |
| `src/video-processing/` (`VideoProcessingModule`, **only** in `WorkerModule`) | `VideoProcessingProcessor` (BullMQ `WorkerHost`), `VideoProcessingService` (probe → thumbnail → `ready`; failure policy), `MediaProbeService` (`ffprobe`/`ffmpeg` via `execFile` over presigned URLs) |

Flow: `POST /videos` creates a `draft` + S3 multipart upload and returns one presigned PUT URL per part → the client uploads parts **directly to storage** (the API never receives file bytes; max 10 GiB) → `POST /videos/:id/upload/complete` lists parts server-side, completes the upload, checks the size, sets `processing` and enqueues `process-video` (`jobId` = video id, 3 attempts, exponential backoff) → the worker extracts duration/metadata, stores `thumbnails/{id}.jpg` and sets `ready` (undecodable media → `failed` without retries).

Status lifecycle: `draft → processing → ready | failed` (`videos.status`). Videos are addressed by an 11-char `public_id` (`{APP_URL}/videos/{public_id}`).

Endpoints (`VideosController`, `@SkipThrottle()`):

| Method & path | Auth | Result |
|---------------|------|--------|
| `POST /videos` | JWT | 201 upload session (draft + part URLs) |
| `POST /videos/:id/upload/complete` | JWT, owner | 202 video in `processing` |
| `GET /videos/:id` | public; optional JWT | 200 details — `ready` for anyone, any status for the owner |
| `GET /videos/:id/stream` | public; optional JWT | 302 to presigned URL (storage answers `Range` with 206) |
| `GET /videos/:id/download` | public; optional JWT | 302 to presigned URL with `Content-Disposition: attachment` |
| `GET /videos/:id/thumbnail` | public; optional JWT | 302 to presigned JPEG URL |

`@Public()` routes still receive the caller when a valid bearer token is sent (`JwtAuthGuard` + `@OptionalUser()`); invalid tokens are ignored there, never rejected.

Env keys (validated in `src/config/env.validation.ts`, defaults in `.env.example`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `UPLOAD_MAX_SIZE_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_URL_EXPIRES_SECONDS`, `DOWNLOAD_URL_EXPIRES_SECONDS`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`.

Library pins: `@nestjs/bullmq@^11` (12.x is ESM-only and breaks ts-jest), `bullmq@^6` + `ioredis` (optional peer, must be installed), `@aws-sdk/client-s3` with `requestChecksumCalculation: 'WHEN_REQUIRED'` for presigned part uploads. Details in `docs/phases/phase-03-videos/library-refs.md`.

**Entity graph:** `autoLoadEntities` only knows entities registered via `forFeature` in imported modules. `Channel` relates to both `User` and `Video`, so any root module that loads `Channel` must also import `UsersModule` and `VideosModule` (see `src/worker/worker.module.ts`); test DataSources list `User, Channel, RefreshToken, VerificationToken, Video` explicitly.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
