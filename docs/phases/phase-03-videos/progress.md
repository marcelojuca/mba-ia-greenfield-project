# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/15 completed

### SI-03.1 — Dependencies, Configuration Namespaces and Env Contract
- **Status:** completed
- **Tests:** 12/12 passing (env.validation.integration-spec.ts: 4 existing + 5 new storage/queue cases); tsc 0
- **Observations:** 
  - `bullmq@6` loads `ioredis` lazily as an optional peer — installed `ioredis@^5.11.1` explicitly (recorded in library-refs.md).
  - Out of scope: `.env.example` keeps the pre-existing unquoted `MAIL_FROM="StreamTube" <noreply@streamtube.com>` that CLAUDE.md warns breaks shell/Compose parsing; the local `.env` uses the quoted form. Suggest a separate fix task.

### SI-03.2 — Docker Compose Infrastructure: Object Storage, Queue Broker and FFmpeg
- **Status:** completed
- **Tests:** no tests — verified manually: minio + redis healthy, `ffprobe -version` 5.1.9 in nestjs-api, MinIO console http://localhost:9001 → 200, redis maxmemory-policy=noeviction
- **Observations:** 
  - Host port 6379 was already allocated on the dev machine; Redis is exposed only on the Compose network (no host port) since only the API and worker containers use it.

### SI-03.3 — Storage Module (S3 Client, Multipart and Presigned URLs)
- **Status:** completed
- **Tests:** 10/10 passing (storage.service.integration-spec.ts: 9 against real MinIO, storage.module.spec.ts: 1)
- **Observations:** 
  - Presigned part uploads work against MinIO with `requestChecksumCalculation: WHEN_REQUIRED` (the library-refs flag is confirmed).
  - Added `src/test/presigned-request.ts`: sends a host-signed presigned URL to `minio:9000` with the original `Host` header so container tests exercise the exact URL a browser would get.
  - Testing guide `references/external-systems.md` Object Storage section now documents real MinIO (validation ICC-1).

### SI-03.4 — Video Entity, Migration and Unique Public Id
- **Status:** completed
- **Tests:** 16/16 SI tests passing (video.entity.integration-spec: 7, public-id.util.spec: 2, migrations.integration-spec: 2 + 5 regression suites re-run); full unit/integration 168/168, e2e 52/52
- **Observations:** 
  - Entity uses `@PrimaryGeneratedColumn("uuid")` (entity rule) with the id assigned in code before insert; the integration test proves the explicit id is persisted.
  - Adding `Channel#videos` broke `AppModule` bootstrap (openapi-export test) because no module registered `Video` via `forFeature` — created the owning `VideosModule` shell with `TypeOrmModule.forFeature([Video])` and registered it in `AppModule` now (the plan had that registration in SI-03.7/SI-03.8).
  - Every test DataSource listing `Channel` now also lists `Video` (10 spec files), and `cleanAllTables` deletes `videos` first.
  - Generated migration `1795153056068-CreateVideos` reviewed: enum type, unique `public_id`, `channel_id` index, FK `ON DELETE CASCADE`.

### SI-03.5 — Optional Requester Identity on Public Routes
- **Status:** completed
- **Tests:** 8/8 passing (jwt-auth.guard.spec.ts: 3 new public-route cases); regression auth.e2e-spec.ts 45/45
- **Observations:** 
  - Guard refactored into `extractBearerToken`/`verifyOrUndefined` helpers so public and protected paths share token parsing; protected-route behavior unchanged (verified by the existing auth e2e suite).
  - E2E coverage of `@OptionalUser()` comes with the video read endpoints (SI-03.13).

### SI-03.6 — Queue Foundation and Video Processing Producer
- **Status:** completed
- **Tests:** 4/4 passing (video-processing.producer.integration-spec.ts: 3 against real Redis, queue.module.spec.ts: 1); e2e regression 52/52
- **Observations:** 
  - `@nestjs/bullmq@12` (and `@nestjs/bull-shared@12`) are ESM-only and fail under ts-jest/CommonJS (`SyntaxError: Unexpected token export`). Pinned `@nestjs/bullmq@^11.0.5` (CommonJS, peers bullmq ^6 + Nest 11) and recorded a `**Revisions:**` entry on TD-01, propagated to context.md, library-refs.md and the plan.
  - `test/jest-e2e.json` has `rootDir: test`, so the setup file is referenced as `<rootDir>/../src/test/jest-setup-env.ts`.
  - `QueueModule` imported in `AppModule` (root BullMQ connection for the API producer).

### SI-03.7 — Video Upload Initiation Service (Draft Pre-registration)
- **Status:** completed
- **Tests:** 16/16 SI tests passing (upload-part-plan.util.spec: 4, videos.service.spec: 8 unit, videos.service.integration-spec: 3 against PostgreSQL+MinIO+Redis, videos.module.integration-spec: 1); src/videos + src/channels 53/53
- **Observations:** 
  - Module compile test named `videos.module.integration-spec.ts` (plan said `.spec.ts`): it needs real DB/Redis/MinIO connections, and nestjs-project/CLAUDE.md requires the integration suffix for anything that opens a connection.
  - Added `src/common/database/pg-errors.ts` (`isUniqueViolationOn`) for the public_id retry; `ChannelsService` keeps its private copy of the same check — consolidating it is a cosmetic refactor left out of scope.
  - Added `src/test/video-test-module.ts` (`createVideoTestingModule`, `createChannelOwner`) reused by every video integration spec.

### SI-03.8 — Endpoint POST /videos (Start Upload)
- **Status:** completed
- **Tests:** 6/6 passing (videos.e2e-spec.ts — POST /videos: 201 contract, direct PUT to storage, 400 VALIDATION_ERROR, 400 VIDEO_TOO_LARGE, exactly 10 GiB → 103 part URLs, 401)
- **Observations:** 
  - Response mapping lives in `VideoPresenter` (owner-only fields, unique URL from `APP_URL`) so the controller stays a thin delegate.
  - Shared e2e helpers in `test/helpers/e2e-app.ts`: `createE2eApp()` (mirrors main.ts pipes/filters) and `createConfirmedUser()` (register → confirm → login; clears throttler storage because auth endpoints are limited to 10 req/min).

### SI-03.9 — Upload Completion and Processing Hand-off
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Media Probe Service (ffprobe / ffmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Video Processing Service and Queue Processor
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Video Worker Entrypoint and Compose Service
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Read, Stream, Download and Thumbnail Endpoints
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — End-to-End Upload → Processing → Streaming Pipeline
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Documentation: OpenAPI Export, HTTP Examples and CLAUDE.md
- **Status:** pending
- **Tests:** —
- **Observations:** none
