---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-19
scope_description: "Video upload (up to 10GB) without loading the API, background processing queue + FFmpeg worker (duration/metadata/thumbnail), object storage layout, unique video URLs, streaming and download, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the `videos` module (pre-registration, upload handshake, stream/download endpoints), the object-storage client, the queue producer, the video worker entrypoint, the `videos` migration and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — no open decision in this document: the video UI (upload screen, player) is explicitly out of scope for this phase. The two Cross-layer TDs below (TD-02 upload protocol, TD-07 stream/download delivery) describe the frontend-side impact so a future frontend phase inherits a fixed contract.

**Fixed by the project (not reopened here):** object storage is S3-compatible (`docs/project-plan.md`, `docs/diagrams/software-arch.mermaid`: "S3 or MinIO") — MinIO locally, S3 in production. Inherited: `@nestjs/config` + `registerAs` namespaces + Joi env validation (phase-01 TD-01..04), domain exception filter and `{ statusCode, error, message }` envelope (phase-02-auth/TD-07), global JWT guard with `@Public()` opt-out (phase-02-auth/TD-02), class-validator DTOs (phase-02-auth/TD-06).

**Sources consulted:** Context7 `/nestjs/bull` (`@nestjs/bullmq` — `BullModule`, `@Processor`, `WorkerHost`, `@OnWorkerEvent`), Context7 `/taskforcesh/bullmq` (job ids, retries/backoff, `UnrecoverableError`, connections), Context7 `/aws/aws-sdk-js-v3` (`@aws-sdk/s3-request-presigner` `getSignedUrl`, `lib-storage` `Upload`), Context7 `/timgit/pg-boss`; AWS S3 quotas (https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html — single PUT ≤ 5 GiB; multipart: 10,000 parts, 5 MiB–5 GiB per part); npm registry (`fluent-ffmpeg@2.1.3` flagged as no longer supported). Installed versions checked in `nestjs-project/package.json` (NestJS 11, TypeORM 0.3.28, Node 25 in `Dockerfile.dev`).

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". The API publishes one job per uploaded video and an FFmpeg worker consumes it. Processing a 10GB file can take minutes, so the queue needs retries with backoff, visibility of job state, and safe redelivery if the worker dies mid-job. This is the main stack decision of the phase.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue; `@nestjs/bullmq` gives `BullModule.forRootAsync/registerQueue`, `@InjectQueue`, and `@Processor` classes extending `WorkerHost` with `@OnWorkerEvent('failed')` hooks.
- **Pros:** first-class NestJS integration (official `@nestjs/bullmq@12`, peer `@nestjs/core ^11`); built-in `attempts` + exponential `backoff`, `UnrecoverableError` to skip retries, stalled-job recovery, custom `jobId` for de-duplication; small ops footprint (one `redis` container).
- **Cons:** adds Redis as a new infrastructure dependency; Redis persistence must be configured to avoid losing queued jobs on restart; job payloads are opaque to the DB (no transactional enqueue with PostgreSQL).

### Option B: RabbitMQ (`@golevelup/nestjs-rabbitmq` / `amqplib`)
- AMQP broker with durable queues, acks, and dead-letter exchanges.
- **Pros:** a real message broker with strong delivery guarantees and routing; language-agnostic consumers (a future non-Node worker could consume).
- **Cons:** retries with backoff require DLX/TTL plumbing by hand; no job-state API (status lives only in our DB); heavier container and more concepts (exchanges, bindings) for a single job type; NestJS integration is community-maintained.

### Option C: pg-boss (PostgreSQL-backed queue)
- Job queue stored in PostgreSQL tables using `SKIP LOCKED`.
- **Pros:** no new infrastructure (reuses `db`); enqueue can share the same DB transaction as the video status update (no dual-write).
- **Cons:** no official NestJS module; polling adds load to the primary database that also serves the API; contradicts the architecture diagram, which models the queue as a separate container.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option with an official NestJS 11 integration and gives retries/backoff/unrecoverable-failure semantics out of the box, which the failure lifecycle (TD-08) relies on. Redis is a single lightweight container and matches the diagram's separate "Message Queue" container. The dual-write risk (DB commit + enqueue) is handled by the ordering/compensation rule in TD-08 instead of a transactional queue.

**Decision:** A (BullMQ on Redis)
**Libraries:** bullmq@^6.7.8, @nestjs/bullmq@^11.0.5, ioredis@^5.11.1

**Revisions:**
- 2026-11-20 — `@nestjs/bullmq` pinned to `^11.0.5` instead of `^12.0.2` (same Option A). Rationale: `@nestjs/bullmq@12` and `@nestjs/bull-shared@12` ship as ESM-only (`"type": "module"`) and cannot be loaded by the project's CommonJS + ts-jest toolchain (`SyntaxError: Unexpected token 'export'`, found in SI-03.6); `11.0.5` is CommonJS and declares peers `bullmq ^6` and `@nestjs/core ^11`.
- 2026-11-20 — `ioredis@^5.11.1` added. Rationale: `bullmq@6` loads `ioredis` lazily as an optional peer; it must be installed explicitly to connect with `{ host, port }` options (found in SI-03.1).

---

## TD-02: Large-File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB body held by the API would tie up a Node process, memory/disk and a connection for the whole transfer — the capability explicitly forbids performance impact. The protocol defines the handshake both the backend and any future client must implement. Hard limits from S3: a single PUT is capped at 5 GiB; multipart uploads allow up to 10,000 parts of 5 MiB–5 GiB.

**Options:**

### Option A: Streaming multipart/form-data through the API
- Client POSTs the file to the API; the API pipes the stream (busboy) into `@aws-sdk/lib-storage` `Upload` toward S3.
- **Pros:** simplest client (one request); API sees every byte, so size/type can be enforced inline.
- **Cons:** every byte still flows through the API (bandwidth, open connections, timeouts on 10GB); no resume — a dropped connection restarts from zero; scales API instances with upload traffic.

### Option B: Single presigned PUT URL
- API returns one presigned `PutObject` URL; client uploads directly to storage.
- **Pros:** API leaves the data path; trivial client.
- **Cons:** **S3 rejects single PUTs above 5 GiB** — cannot satisfy the 10GB requirement; no resume.

### Option C: S3 multipart upload with presigned part URLs
- API creates the video draft and calls `CreateMultipartUpload`, then returns one presigned `UploadPart` URL per part. The client PUTs parts directly to storage (in parallel, retrying single parts), then calls the API to complete. The API runs `ListParts` server-side and `CompleteMultipartUpload` — the client does not need to read `ETag` headers.
- **Pros:** API never touches the bytes (only signs URLs, offline); supports 10GB and beyond, parallel and per-part retry; works identically on MinIO and S3.
- **Cons:** multi-step handshake on the client; abandoned uploads leave incomplete parts in storage (needs an abort/lifecycle rule); declared size must be re-validated after completion because presigned parts cannot cap byte counts.

### Option D: tus resumable protocol (`@tus/server` + S3 store)
- tus server mounted in the API, storing chunks to S3.
- **Pros:** standard resumable protocol with mature clients (Uppy, tus-js-client).
- **Cons:** bytes still flow through the API (same load issue as A); extra server component and protocol state to operate.

**Recommendation:** **Option C (S3 multipart with presigned part URLs)** — it is the only option that both supports 10GB and keeps the API out of the data path. Server-side `ListParts` keeps the client contract minimal (no CORS `ETag` exposure needed). Parameters: max size 10 GiB (10,737,418,240 bytes) declared at initiation and validated; part size 100 MiB, raised to `ceil(size / 10,000)` if needed (103 parts for 10 GiB); part URLs valid for 24h; after completion the API checks the stored object size equals the declared size. Frontend impact: the future upload screen splits the `File` into `partSize` slices, PUTs each to its URL, then calls the complete endpoint.

**Decision:** C (S3 multipart upload with presigned part URLs)
**Libraries:** @aws-sdk/client-s3@^3.1173.0, @aws-sdk/s3-request-presigner@^3.1173.0

---

## TD-03: Object Storage Layout and Endpoint Strategy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** S3/MinIO is fixed by the project; what remains open is how objects are organized, how buckets get provisioned, and which endpoint presigned URLs carry. The last point is a cross-component contract (env schema + `compose.yaml` + runtime): inside Docker the API reaches MinIO as `minio:9000`, while a browser on the host reaches it as `localhost:9000`, and SigV4 signatures cover the host.

**Options:**

### Option A: One private bucket, key prefixes per asset type, app-provisioned
- Single bucket (`S3_BUCKET`, default `streamtube`), keys `videos/{videoId}/source` and `thumbnails/{videoId}.jpg`. All access through presigned URLs. API and worker ensure the bucket exists at startup (`HeadBucket` → `CreateBucket`). Two endpoints: `S3_ENDPOINT` (internal, used for API/worker calls) and `S3_PUBLIC_ENDPOINT` (used only to sign URLs handed to clients).
- **Pros:** one bucket policy (private); keys derived from the immutable video id never collide; works with zero manual setup in dev and tests; signing is offline, so the public endpoint need not be reachable from the container.
- **Cons:** app needs `CreateBucket` permission in dev (in production the bucket is provisioned by infrastructure and the check becomes a no-op).

### Option B: Two buckets (`videos`, `thumbnails`), provisioned by an init container (`mc mb`)
- Separate buckets per asset type, created by a one-shot Compose service.
- **Pros:** per-bucket policies/lifecycle (e.g., public-read thumbnails later).
- **Cons:** two names to configure everywhere; an extra one-shot container; tests depend on the init container having run.

### Option C: Public-read bucket with permanent object URLs
- Objects readable anonymously; the API returns direct URLs.
- **Pros:** no signing; CDN-friendly.
- **Cons:** draft and failed videos become publicly fetchable by key; no way to revoke access; conflicts with the private-by-default posture needed until publication rules arrive (Phase 04).

**Recommendation:** **Option A** — a private single bucket with deterministic, id-based keys is the simplest layout that keeps drafts private and needs no extra container; the internal/public endpoint split is the minimum needed for presigned URLs to work both inside Docker and from the host. Path-style addressing (`forcePathStyle: true`) is required for MinIO.

**Decision:** A (single private bucket, prefixed keys, app-provisioned, internal/public endpoints)
**Libraries:** @aws-sdk/client-s3@^3.1173.0

---

## TD-04: Video Worker Runtime

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram has a separate "Video Worker (FFmpeg)" container. FFmpeg work is CPU- and I/O-heavy and must not compete with request handling. The worker also needs the `Video` entity, the storage client and config — the question is where that code lives and how it is deployed.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). A `video-worker` Compose service runs it from the same image as the API (the image gains `ffmpeg`).
- **Pros:** reuses entities, config namespaces, storage service and conventions without duplication; independent scaling/restarts; matches the diagram; one test toolchain.
- **Cons:** API image also carries `ffmpeg` (acceptable in dev; a production build can split images); two processes must be kept on the same code version.

### Option B: Processor inside the API process
- `@Processor` registered in `AppModule`; the API process also consumes jobs.
- **Pros:** zero new services.
- **Cons:** FFmpeg on a 10GB file starves the event loop host/CPU used for HTTP — violates "sem impacto na performance"; contradicts the diagram.

### Option C: Separate project in another language (e.g., Python/Go worker)
- Independent service consuming the queue.
- **Pros:** best-in-class media libraries; full isolation.
- **Cons:** duplicates the data model and config; BullMQ is Node-first (other clients exist but are less mature); a second stack to test and maintain.

**Recommendation:** **Option A** — the separate container satisfies isolation, while sharing the NestJS codebase keeps the `Video` entity and storage logic single-sourced (Working Principles: single responsibility, no duplication).

**Decision:** A (same codebase, `src/worker.ts` entrypoint, `video-worker` Compose service)

---

## TD-05: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker needs duration + technical metadata and one frame rendered as a thumbnail. Source files can be 10GB, so how the worker reads the file matters as much as which tool runs.

**Options:**

### Option A: `ffprobe`/`ffmpeg` CLI via `child_process.execFile`, reading a presigned HTTP URL
- System `ffmpeg` (Debian package) in the image. `ffprobe -print_format json -show_format -show_streams <url>` for metadata; `ffmpeg -ss <t> -i <url> -frames:v 1` for the thumbnail. Both read the object over HTTP with range requests, so only the container header and the frames near the seek point are fetched.
- **Pros:** no 10GB download or scratch disk; no wrapper library to go stale; JSON output is easy to type; `execFile` avoids shell injection.
- **Cons:** we own argument building and output parsing; depends on network reads from storage during processing.

### Option B: `fluent-ffmpeg` wrapper
- Popular fluent API over the same binaries.
- **Pros:** less argument plumbing.
- **Cons:** the npm package is flagged "no longer supported" (`fluent-ffmpeg@2.1.3`); adds a dependency for a handful of arguments.

### Option C: Download the source to a temp file, then run FFmpeg locally
- `GetObject` stream to disk, process, delete.
- **Pros:** fastest random access once downloaded; independent of storage latency.
- **Cons:** 10GB of disk and transfer per job just to read headers and one frame; slower end-to-end.

**Recommendation:** **Option A** — reading via a presigned URL lets FFmpeg seek with HTTP ranges, so processing cost does not scale with file size for metadata/thumbnail work. Parameters: thumbnail frame at 10% of the duration (avoids black intro frames; `0` when duration is unknown), JPEG scaled to 1280px wide preserving aspect ratio; persisted metadata = duration, width, height, video codec, audio codec (nullable), container format, bit rate, frame rate. A file with no video stream is a permanent failure (TD-08).

**Decision:** A (ffprobe/ffmpeg CLI via execFile over presigned URL)
**Libraries:** — (system `ffmpeg` 5.1 from Debian bookworm apt in `Dockerfile.dev`; Node `child_process`)

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a public identifier used in its URL (`/videos/{id}`), stable from the moment it is pre-registered and never shared with another video.

**Options:**

### Option A: Expose the UUID primary key
- URL uses `videos.id` (uuid v4).
- **Pros:** no extra column; uniqueness guaranteed by the PK.
- **Cons:** 36-char URLs; couples the public URL to an internal key.

### Option B: Random short `public_id` (11 chars, base64url) with a unique index
- `crypto.randomBytes(8)` → 11 base64url chars (64 bits). Unique constraint in the DB; on the (astronomically rare) `23505` collision, regenerate and retry.
- **Pros:** short, URL-safe, non-sequential (not enumerable); decoupled from the PK; the DB constraint is the real guarantee.
- **Cons:** one extra column + index; a retry path that exists mainly for correctness.

### Option C: Slug from the title plus suffix
- e.g. `my-trip-ab12cd`.
- **Pros:** human-readable URLs.
- **Cons:** the title changes in Phase 04 (edit), so the URL would either change or go stale; title is not meaningful at upload time.

**Recommendation:** **Option B** — a random short id gives clean, non-enumerable URLs that never change when titles are edited in Phase 04, with uniqueness enforced by the DB. Generated with Node's `crypto` (no dependency; `nanoid@5` is ESM-only and the project compiles to CommonJS).

**Decision:** B (11-char base64url `public_id`, unique index, retry on collision)

---

## TD-07: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback without full download requires HTTP range requests (`206 Partial Content`). The diagram has the frontend streaming directly from Object Storage. The choice also decides whether the API sits in the byte path again (see TD-02).

**Options:**

### Option A: API proxies bytes with Range support
- `GET /videos/:id/stream` parses `Range`, calls `GetObject` with the same range, pipes the body with `206` + `Content-Range`.
- **Pros:** one origin for the client; per-request authorization on every chunk.
- **Cons:** every byte of every view flows through the API — the exact load the upload design avoided; we re-implement range semantics.

### Option B: API authorizes, then redirects (302) to a short-lived presigned GET URL
- `/stream` → presigned `GetObject` (inline); `/download` → presigned `GetObject` with `ResponseContentDisposition: attachment; filename="..."`. Storage serves `Range`/`206` natively.
- **Pros:** API leaves the data path; range/seek semantics are S3's (well-tested); same endpoints work for `<video src>` and download links; matches the diagram (frontend streams from storage).
- **Cons:** URLs are bearer tokens until expiry (mitigated by short TTL); client must follow redirects (browsers and `<video>` do).

### Option C: Adaptive streaming (HLS/DASH) via transcoding
- Worker transcodes to segmented renditions; player fetches a manifest.
- **Pros:** adaptive bitrate, best playback experience.
- **Cons:** transcoding a 10GB file multiplies processing time and storage; not required by the phase ("reprodução via streaming", not adaptive); can be layered later on top of the same pipeline.

**Recommendation:** **Option B** — redirecting to presigned URLs delivers range-based streaming and downloads with zero API bandwidth, consistent with TD-02. TTL: 1h. Thumbnails use the same mechanism (`/videos/:id/thumbnail`). Frontend impact: use the API URLs directly as `<video src>` / `<img src>` / download `href`.

**Decision:** B (302 redirect to short-lived presigned GET URLs)
**Libraries:** @aws-sdk/s3-request-presigner@^3.1173.0

**Revisions:**
- 2026-11-19 — Access policy fixed for Phase 03 (validation AMB-1): video details, stream, download and thumbnail are `@Public()` and served to anyone holding the unique URL once `status = ready`; the channel owner (identified by an optional bearer token) also reads non-ready videos' details. Rationale: Phase 04 owns publication/visibility; until then the unguessable `public_id` (TD-06) behaves like an unlisted link, honoring "anonymous users watch freely".

---

## TD-08: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Serviço de processamento em segundo plano (filas)

**Context:** The phase requires a draft to exist as soon as an upload starts and processing to start automatically after it ends. The status set, the transitions, what retries happen and how a processing failure is recorded must be consistent across API, queue and worker. Enqueueing after a DB update is a dual write (PostgreSQL + Redis) that can partially fail.

**Options:**

### Option A: Four states `draft → processing → ready | failed`, bounded retries
- `draft` on initiation; `processing` when the API completes the multipart upload and enqueues; the worker sets `ready` (with duration/metadata/thumbnail) or, after the final attempt, `failed` with `processing_error`. Jobs: 3 attempts, exponential backoff (5s base); media with no video stream throws `UnrecoverableError` (no retries). Dual write: commit `processing` first, then enqueue with `jobId = video id` (de-duplicated); if enqueue fails, revert to `draft` (compensation) so the client can retry completion. Worker is idempotent (skips videos not in `processing`; deterministic keys).
- **Pros:** minimal states that map 1:1 to the phase wording; transient faults (storage/network) self-heal; permanent faults stop immediately; at-least-once delivery is safe.
- **Cons:** "upload in progress" and "created but abandoned" are both `draft` (distinguishable by `upload_id` being set).

### Option B: Finer states (`draft`, `uploading`, `uploaded`, `processing`, `ready`, `failed`)
- Separate states for each handshake step.
- **Pros:** more precise reporting.
- **Cons:** the API never sees bytes, so `uploading` cannot be detected reliably; more transitions to keep consistent with no consumer needing them in this phase.

### Option C: No automatic retries; any error → `failed`
- Single attempt.
- **Pros:** simplest.
- **Cons:** a transient MinIO/network blip permanently fails a 10GB upload — the user must re-upload.

**Recommendation:** **Option A** — the four states are exactly what the phase describes, the retry policy distinguishes transient from permanent failures, and commit-then-enqueue with compensation plus `jobId` de-duplication gives at-least-once processing without an outbox table. The editorial draft → published flow is Phase 04 and will be modeled separately from this processing status.

**Decision:** A (draft → processing → ready | failed; 3 attempts, exponential backoff; commit-then-enqueue with compensation)

---

## TD-09: Environment Variable Contract for Storage, Queue and Upload Limits

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo)

**Context:** Added after `/plan-validate` (MD-2). The keys are read by the Joi schema (`src/config/env.validation.ts`), the `registerAs` config namespaces, `compose.yaml` (API + worker + MinIO credentials) and `.env.example` — a cross-component contract (phase-01 precedent). TD-03 named only the endpoint/bucket keys.

**Options:**

### Option A: Discrete keys in two new namespaces (`storage`, `queue`) plus upload/stream limits in `storage`
- `storage`: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `UPLOAD_MAX_SIZE_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_URL_EXPIRES_SECONDS`, `DOWNLOAD_URL_EXPIRES_SECONDS`. `queue`: `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`. Defaults point to Compose service names (`http://minio:9000`, `redis`).
- **Pros:** same style as `DB_HOST`/`DB_PORT` and `MAIL_HOST`/`MAIL_PORT`; each value validated individually by Joi (`uri()`, `port()`, numeric bounds); `QUEUE_PREFIX` lets tests isolate their queue.
- **Cons:** more keys to keep in sync across `.env.example` and Compose.

### Option B: Connection URLs (`REDIS_URL`, `S3_URL` with embedded credentials) + limits as code constants
- Two URL strings; limits hardcoded in `videos.constants.ts`.
- **Pros:** fewer keys; URL form common in PaaS.
- **Cons:** breaks the established discrete-key style; credentials embedded in URLs leak into logs; limits cannot be tuned per environment (e.g., smaller part size in tests).

**Recommendation:** **Option A** — mirrors the existing `DB_*`/`MAIL_*` conventions and lets Joi validate each value, while keeping limits overridable per environment. Defaults: `S3_REGION=us-east-1`, `S3_BUCKET=streamtube`, `UPLOAD_MAX_SIZE_BYTES=10737418240`, `UPLOAD_PART_SIZE_BYTES=104857600`, `UPLOAD_URL_EXPIRES_SECONDS=86400`, `DOWNLOAD_URL_EXPIRES_SECONDS=3600`, `REDIS_PORT=6379`, `QUEUE_PREFIX=streamtube`.

**Decision:** A (discrete keys in `storage` and `queue` namespaces)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ on Redis | A |
| TD-02 | Cross-layer | Large-File Upload Protocol (up to 10GB) | S3 multipart with presigned part URLs | C |
| TD-03 | Backend | Object Storage Layout and Endpoint Strategy | Single private bucket, prefixed keys, app-provisioned, internal/public endpoints | A |
| TD-04 | Backend | Video Worker Runtime | Same codebase, separate entrypoint + Compose service | A |
| TD-05 | Backend | Metadata Extraction and Thumbnail Generation | ffprobe/ffmpeg CLI over presigned URL | A |
| TD-06 | Backend | Unique Video URL Identifier | 11-char base64url `public_id` | B |
| TD-07 | Cross-layer | Streaming and Download Delivery | 302 to presigned GET URLs | B |
| TD-08 | Backend | Video Status Lifecycle and Failure Handling | draft → processing → ready/failed, bounded retries | A |
| TD-09 | Backend | Environment Variable Contract for Storage, Queue and Upload Limits | Discrete keys in `storage`/`queue` namespaces | A |
