# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/15 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Video Entity, Migration and Unique Public Id
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
