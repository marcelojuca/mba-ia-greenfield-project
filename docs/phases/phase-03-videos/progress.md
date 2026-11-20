# phase-03-videos — Progress

**Status:** completed
**SIs:** 15/15 completed

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
- **Status:** completed
- **Tests:** 29 SI tests passing (videos.service.spec: 10 new completeUpload unit cases; videos.service.integration-spec: 4 new against PostgreSQL+MinIO+Redis incl. compensation; videos.e2e-spec: 5 new); src/videos 42/42, videos e2e 11/11
- **Observations:** 
  - Completion validates the uploaded parts themselves (contiguous from 1, total ≥ declared size) instead of recomputing the expected part count from the current `UPLOAD_PART_SIZE_BYTES`, so a config change between initiate and complete cannot break in-flight uploads.
  - S3 `EntityTooSmall`/`InvalidPart`/`InvalidPartOrder` on completion are mapped to `UPLOAD_INCOMPLETE` (the multipart upload stays open for the client to fix).
  - Commit is a conditional update (`WHERE status = draft`); `affected = 0` → `VIDEO_NOT_DRAFT`, covering concurrent completions.
  - Retry after compensation reuses the already-assembled object (`headObject` first), proven by the integration test.

### SI-03.10 — Media Probe Service (ffprobe / ffmpeg)
- **Status:** completed
- **Tests:** 9/9 passing (media-probe.parser.spec: 4 unit; media-probe.service.integration-spec: 5 with real ffprobe/ffmpeg over presigned MinIO URLs) — stable across 2 runs
- **Observations:** 
  - Corrupt sources do not reach the no-video-stream branch: ffprobe exits 1 (`Invalid data found when processing input` / `moov atom not found`). `MediaProbeService` raises `InvalidMediaError` for those so the worker can fail without retries (TD-05/TD-08 intent: undecodable media is permanent).
  - Errors are classified by exclusion: only network/HTTP/timeout failures are transient; every other failure on fetched bytes is `InvalidMediaError` (decode messages vary by demuxer — random bytes are sometimes sniffed as MP3 with `Invalid argument`).
  - Corrupt fixture uses plain text instead of random bytes to keep the test deterministic.

### SI-03.11 — Video Processing Service and Queue Processor
- **Status:** completed
- **Tests:** 20 SI tests passing (video-processing.service.spec: 11 unit, video-processing.processor.spec: 4 unit, video-processing.service.integration-spec: 4 with PostgreSQL+MinIO+ffmpeg, video-processing.module.integration-spec: 1); src/video-processing 29/29
- **Observations:** 
  - The final-attempt decision (`attemptsMade >= attempts` or `UnrecoverableError`) lives in `VideoProcessingService.handleFailure`; the processor only delegates (layer-separation rule) and its `failed` handler logs instead of rethrowing (background-task rule).
  - `markReady`/`markFailed` are conditional updates on `status = processing`, so redelivered or stale jobs never regress a video.
  - Module compile test named `.integration-spec.ts` (it opens DB/Redis/MinIO connections and starts a worker), consistent with SI-03.7.

### SI-03.12 — Video Worker Entrypoint and Compose Service
- **Status:** completed
- **Tests:** 3/3 passing (worker.module.integration-spec.ts: real createApplicationContext — entity graph, running BullMQ worker, no HTTP adapter); full npm test 237/237, npm run test:e2e 63/63; live check: video-worker container logs 'Video worker started', a job enqueued while it was stopped stayed waiting and was consumed after restart
- **Observations:** 
  - The worker crashed at boot with `Entity metadata for Channel#user was not found`: `autoLoadEntities` only sees entities registered by imported modules, so `WorkerModule` imports `UsersModule` to complete the Video → Channel → User graph. Integration tests had not caught it because test DataSources list entities explicitly — the new WorkerModule test boots the real module.
  - Root setup extracted into `src/config/config-module.options.ts` and `src/database/database.module.ts`, now shared by `AppModule` and `WorkerModule`.
  - Worker dev build uses `tsconfig.worker.json` (`outDir: dist-worker`) so its `nest start --watch` never deletes the API dist/; `dist-worker` is git-ignored and excluded from `tsconfig.json`.
  - Running the full e2e suite exposed that `npm run test:e2e` was NOT serialized (contrary to CLAUDE.md: suites ran in parallel workers and hit FK violations). Added `maxWorkers: 1` to both Jest configs so plain `npm test` / `npm run test:e2e` are serial by construction.

### SI-03.13 — Read, Stream, Download and Thumbnail Endpoints
- **Status:** completed
- **Tests:** 22 SI tests passing (videos.service.spec: 12 new unit cases for read policy, playback URLs and RFC 6266 disposition; videos.e2e-spec: 10 new — 200/404 per status and requester, stream 302 → storage 206 with exact bytes, download attachment + identical bytes, thumbnail JPEG, 409 VIDEO_NOT_READY, no throttling on playback); videos e2e 21/21
- **Observations:** 
  - Download `Content-Disposition` follows RFC 6266/5987 (`filename` ASCII fallback + UTF-8 `filename*`), so names with accents or quotes survive.
  - Playback endpoints use `@Redirect(undefined, 302)` returning `{ url }`; OpenAPI documents the 302 + `Location` header via a shared `PlaybackResponses` decorator.
  - Ready-state e2e cases arrange the worker end state directly (DB update + thumbnail object); the real worker path is proven in SI-03.14.
  - Videos e2e now deletes the stored objects of every video before wiping tables (`deleteStoredVideoObjects`).

### SI-03.14 — End-to-End Upload → Processing → Streaming Pipeline
- **Status:** completed
- **Tests:** 3/3 passing (video-pipeline.e2e-spec.ts over real PostgreSQL, MinIO, Redis, ffmpeg and an in-process WorkerModule): ~8 MB H.264 upload in 2 presigned parts → ready with 640×360/h264/aac metadata, thumbnail JPEG, stream Range 206 on the last KiB, byte-identical download; corrupt upload → failed after 1 attempt; two uploads → two unique URLs. Full e2e 76/76
- **Observations:** 
  - Part size overridden to 5 MiB (S3 minimum) in this suite only, so a real multi-part upload runs in ~1s; a CBR `bitrate` option was added to the ffmpeg fixture to produce a >5 MiB video.
  - The in-test worker consumes the `streamtube-test` prefix; the `video-worker` container (runtime prefix) never touches these jobs (validation AMB-4).

### SI-03.15 — Documentation: OpenAPI Export, HTTP Examples and CLAUDE.md
- **Status:** completed
- **Tests:** 10/10 passing (openapi-export.integration-spec.ts: new case asserting the 6 /videos operations); every path cited in both CLAUDE.md files verified to exist
- **Observations:** 
  - Root CLAUDE.md had statements contradicted by the code (a `comments` module, `next-frontend/` "not yet initialized", queue "TBD"); corrected alongside the new video section. `docs/diagrams/software-arch.mermaid` queue label updated from TBD to BullMQ on Redis and storage relations to presigned URLs.
  - nestjs-project/CLAUDE.md documents the new services, readiness checks, worker commands, Phase 03 modules/endpoints/env keys, test helpers, library pins and the entity-graph pitfall found in SI-03.12.

## Final verification

- `docker compose exec nestjs-api npm test` — 40 suites, 250/250 passing
- `docker compose exec nestjs-api npm run test:e2e` — 5 suites, 76/76 passing
- `docker compose exec nestjs-api npx tsc --noEmit` — exit 0
- `docker compose exec nestjs-api npm run lint` — exit 0, 0 errors, 0 warnings (test-file override now also disables `no-unsafe-argument`, same rationale as the other `no-unsafe-*` rules: supertest bodies are `any`)
- `docker compose exec nestjs-api npm run build` — exit 0; emits `dist/main.js` and `dist/worker.js`
- `docker compose ps` — `db`, `mailpit`, `minio` (healthy), `redis` (healthy), `nestjs-api`, `video-worker` up

## Follow-ups (out of scope)

- Cleanup of abandoned uploads: abort endpoint and/or storage lifecycle rule `AbortIncompleteMultipartUpload` + stale `draft` sweeper (validation AMB-3).
- `.env.example` keeps the unquoted `MAIL_FROM` with angle brackets that CLAUDE.md warns about (SI-03.1).
- `ChannelsService` still has a private copy of the unique-violation check now available in `src/common/database/pg-errors.ts` (SI-03.7).
- Pre-existing `*.module.spec.ts` files open real DB connections; CLAUDE.md says such tests should be `*.integration-spec.ts` (SI-03.7).
- Video UI (upload screen with part uploads, player) in `next-frontend/` — the API contract is fixed by TD-02/TD-07.
