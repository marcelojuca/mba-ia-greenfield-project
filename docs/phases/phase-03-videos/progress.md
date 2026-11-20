# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/15 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Queue Foundation and Video Processing Producer
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Video Upload Initiation Service (Draft Pre-registration)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoint POST /videos (Start Upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
