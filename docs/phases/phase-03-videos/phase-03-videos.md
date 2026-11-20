---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-19T23:27:59-06:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-19T23:27:48-06:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T23:27:18-06:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-19T20:46:54-06:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of up to 10GB straight to S3-compatible object storage (the API only signs URLs), automatic draft pre-registration, background processing through a BullMQ queue consumed by a dedicated FFmpeg worker (duration, metadata, thumbnail), a unique short URL per video, and range-based streaming plus download — with storage, queue and worker running in Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces and Env Contract

**Description:** Install the Phase 03 libraries and create the `storage` and `queue` config namespaces with the env key set of TD-09, validated by the Joi schema, so every later SI reads typed configuration.

**Technical actions:**

1. Install `bullmq@^6.7.8`, `@nestjs/bullmq@^12.0.2`, `@aws-sdk/client-s3@^3.1173.0`, `@aws-sdk/s3-request-presigner@^3.1173.0` in `nestjs-project` (per `phase-03-videos/TD-01`, `TD-02`, `library-refs.md`)
2. Create `src/config/storage.config.ts` — `registerAs('storage', ...)` with `endpoint`, `publicEndpoint`, `region`, `accessKey`, `secretKey`, `bucket`, `uploadMaxSizeBytes`, `uploadPartSizeBytes`, `uploadUrlExpiresSeconds`, `downloadUrlExpiresSeconds` (per `phase-03-videos/TD-09`)
3. Create `src/config/queue.config.ts` — `registerAs('queue', ...)` with `host`, `port`, `prefix` (per `phase-03-videos/TD-09`)
4. Extend `src/config/env.validation.ts` with the TD-09 keys (`S3_*` URIs/strings, `UPLOAD_PART_SIZE_BYTES` ≥ 5 MiB, `UPLOAD_MAX_SIZE_BYTES` ≤ 5 TiB, TTLs ≤ 604800, `REDIS_PORT` port) and register both namespaces in `AppModule`'s `ConfigModule.forRoot({ load })`
5. Update `.env.example` (and the local `.env`) with Compose-compatible defaults (`S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`, …)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (storage/queue keys) | Integration: Joi schema accepts defaults, rejects invalid values | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Booting the application with only the existing required variables succeeds — every TD-09 key has a default
- `UPLOAD_PART_SIZE_BYTES=1000` fails env validation at bootstrap (below the 5 MiB S3 minimum)
- `S3_ENDPOINT=not-a-url` fails env validation at bootstrap

---

### SI-03.2 — Docker Compose Infrastructure: Object Storage, Queue Broker and FFmpeg

**Description:** Add MinIO and Redis to Compose and FFmpeg to the development image so storage, queue and media tooling are real services reachable by service name.

**Technical actions:**

1. Add `minio` service to `nestjs-project/compose.yaml` — image `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `server /data --console-address :9001`, ports `9000`/`9001`, root credentials matching `S3_ACCESS_KEY`/`S3_SECRET_KEY`, named volume, healthcheck `curl -f http://localhost:9000/minio/health/live` (per `phase-03-videos/TD-03`, `library-refs.md`)
2. Add `redis` service — image `redis:7.4-alpine`, `--appendonly yes --maxmemory-policy noeviction`, named volume, healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`, `library-refs.md`)
3. Make `nestjs-api` depend on `minio` and `redis` being healthy
4. Install `ffmpeg` (Debian apt) in `nestjs-project/Dockerfile.dev` (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Compose services | Manual verification (`docker compose ps`, healthchecks) | — no tests |

**Dependencies:** SI-03.1 — credentials and hostnames come from the TD-09 env contract

**Acceptance criteria:**

- `docker compose up -d` reports `minio` and `redis` as `healthy`
- `docker compose exec nestjs-api ffprobe -version` exits 0
- MinIO console is reachable at `http://localhost:9001` from the host

---

### SI-03.3 — Storage Module (S3 Client, Multipart and Presigned URLs)

**Description:** Encapsulate every object-storage operation of the phase in `StorageService` — bucket provisioning, multipart upload lifecycle, presigned part/GET URLs, metadata and small-object writes — so videos and the worker never touch the AWS SDK directly.

**Technical actions:**

1. Create `src/storage/storage.service.ts` — two `S3Client` instances (`S3_ENDPOINT` for calls, `S3_PUBLIC_ENDPOINT` for client-facing presigning), `forcePathStyle: true`, checksum calculation `WHEN_REQUIRED`; `onModuleInit` ensures the bucket (`HeadBucket` → `CreateBucket`) (per `phase-03-videos/TD-03`, `library-refs.md`)
2. Implement multipart operations: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)`, `listUploadedParts(key, uploadId)` (paginated), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`)
3. Implement object operations: `headObject(key)` (size or `null` when absent), `putObject(key, body, contentType)`, `deleteObject(key)`, `presignGetObject(key, { disposition?, audience: 'public' | 'internal' })` (per `phase-03-videos/TD-05`, `TD-07`)
4. Create `src/storage/storage.module.ts` exporting `StorageService`; create `src/test/presigned-request.ts` — test helper that sends a request to a public presigned URL through the internal endpoint while preserving the signed `Host` header
5. Update `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` "Object Storage" section to the real-MinIO strategy (validation ICC-1)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO — bucket ensure, multipart via presigned part URLs, list/complete, head, presigned GET with `Range` → 206, attachment disposition | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (storage config), SI-03.2 (MinIO service)

**Acceptance criteria:**

- On first start against an empty MinIO the bucket `S3_BUCKET` is created; a second start does not fail
- An object uploaded in two parts through presigned part URLs and completed is readable with the exact concatenated bytes
- A presigned GET request with `Range: bytes=0-9` returns `206` with exactly 10 bytes and a `Content-Range` header
- A presigned download URL returns `Content-Disposition: attachment; filename="..."`
- `headObject` of a missing key returns `null` instead of throwing

---

### SI-03.4 — Video Entity, Migration and Unique Public Id

**Description:** Create the `Video` entity linked to `Channel`, its migration, the processing-status enum and the 11-char `public_id` generator.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` per `### Data Model → Video`, `VideoStatus` enum (`draft`, `processing`, `ready`, `failed`), `bigint` `size_bytes` with a number transformer, `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`, `onDelete: 'CASCADE'` (per `phase-03-videos/TD-08`)
2. Add `@OneToMany(() => Video, (video) => video.channel)` to `Channel` (both sides of the relation)
3. Create `src/videos/public-id.util.ts` — `generatePublicId()` = `crypto.randomBytes(8).toString('base64url')` (11 chars) (per `phase-03-videos/TD-06`)
4. Generate `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` and review it (enum type, FK cascade, unique `public_id`, index on `channel_id`)
5. Update test helpers and the migration runner test: add `videos` to `cleanAllTables`, the new migration and table to `migrations.integration-spec.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: defaults (`status = draft`), unique `public_id`, FK + cascade on channel delete, `size_bytes` round-trips 10 GiB as number | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: length 11, URL-safe alphabet, non-repeating sample | `src/videos/public-id.util.spec.ts` |
| Migrations | Integration: apply all 3 migrations, revert last removes `videos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table and `videos_status_enum` type
- Inserting two videos with the same `public_id` fails with a unique violation
- A new video without explicit status is persisted as `draft`
- Deleting a channel deletes its videos
- A `size_bytes` of `10737418240` is read back as the number `10737418240`

---

### SI-03.5 — Optional Requester Identity on Public Routes

**Description:** Let `@Public()` endpoints know the caller when a valid bearer token is sent, so the owner can read non-ready videos while anonymous access keeps working (validation DG-1, `phase-03-videos/TD-07` revision).

**Technical actions:**

1. Update `src/auth/guards/jwt-auth.guard.ts` — on `@Public()` routes, when an `Authorization: Bearer` header is present and verifies, attach the payload to `request.user`; never reject on a missing/invalid token there
2. Create `src/auth/decorators/optional-user.decorator.ts` — `@OptionalUser()` param decorator returning `JwtPayload | undefined`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `JwtAuthGuard` | Unit: public + valid token sets user; public + invalid token passes without user; protected route behavior unchanged | `src/auth/guards/jwt-auth.guard.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A `@Public()` route called with a valid access token receives the token's payload as the current user
- A `@Public()` route called with an invalid or expired token still returns its normal public response (no 401)
- Protected routes keep returning `401` without a valid token (existing `auth.e2e-spec.ts` stays green)

---

### SI-03.6 — Queue Foundation and Video Processing Producer

**Description:** Register BullMQ globally from the `queue` namespace, declare the `video-processing` queue and implement the producer that enqueues `process-video` jobs with the TD-08 delivery options.

**Technical actions:**

1. Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` reading `queueConfig` (`connection: { host, port }`, `prefix`) (per `phase-03-videos/TD-01`, `TD-09`); import it in `AppModule`
2. Create `src/videos/videos.constants.ts` — `VIDEO_PROCESSING_QUEUE`, `PROCESS_VIDEO_JOB`, `VIDEO_PROCESSING_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: 1000`), storage key builders, `PUBLIC_ID_MAX_RETRIES` (per `phase-03-videos/TD-08`)
3. Create `src/videos/video-processing.producer.ts` — `VideoProcessingProducer.enqueue(videoId)` adding `{ videoId }` with `jobId = videoId` (per `### Events/Messages → video.process`)
4. Create `src/test/jest-setup-env.ts` overriding `QUEUE_PREFIX` to `streamtube-test` and register it after `dotenv/config` in both Jest configs (validation AMB-4)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration: real Redis — job enqueued with payload, options and `jobId`; second enqueue of the same id is de-duplicated | `src/videos/video-processing.producer.integration-spec.ts` |
| `QueueModule` | Unit: compilation | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 (queue config), SI-03.2 (Redis service)

**Acceptance criteria:**

- Enqueuing a video id produces one waiting job named `process-video` with payload `{ videoId }` and `attempts = 3`
- Enqueuing the same video id twice leaves a single job in the queue
- Jobs created by the test suites live under the `streamtube-test` prefix, never under the runtime prefix

---

### SI-03.7 — Video Upload Initiation Service (Draft Pre-registration)

**Description:** Implement the business logic that pre-registers a draft video for the caller's channel and opens a multipart upload with one presigned URL per part.

**Technical actions:**

1. Add `ChannelsService.findByUserId(userId)` returning the user's channel or `null`
2. Create `src/videos/videos.exceptions.ts` — `VideoNotFoundException`, `VideoTooLargeException`, `VideoNotDraftException`, `VideoNotReadyException`, `UploadIncompleteException`, `UploadSizeMismatchException`, `ChannelNotFoundException` extending `DomainException` (per `### Error Catalog`)
3. Create `src/videos/upload-part-plan.util.ts` — `planUploadParts(fileSize, configuredPartSize)` → `{ partSize = max(configured, ceil(size / 10000)), partCount }` (per `phase-03-videos/TD-02`)
4. Create `src/videos/videos.service.ts` — `initiateUpload(userId, input)`: enforce `UPLOAD_MAX_SIZE_BYTES`, resolve channel, default title from the file name (validation AMB-2), insert the draft with a generated `public_id` (regenerate on `23505` on `public_id`, up to `PUBLIC_ID_MAX_RETRIES`), `createMultipartUpload`, persist `upload_id`, presign every part; abort the multipart upload and delete the draft if presigning fails
5. Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, providers `VideosService`, `VideoProcessingProducer`; exports `VideosService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `planUploadParts` | Unit: 10 GiB → 103 parts of 100 MiB; tiny file → 1 part; >1 TiB raises part size | `src/videos/upload-part-plan.util.spec.ts` |
| `VideosService.initiateUpload` | Unit: size limit, title default/truncation, `public_id` collision retry, channel missing (mock repo/storage) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: real DB + MinIO — draft persisted with `upload_id`, part URLs accept uploads | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 (storage), SI-03.4 (entity), SI-03.6 (queue registration)

**Acceptance criteria:**

- Initiating an upload persists a `draft` video owned by the caller's channel with `upload_id`, `storage_key = videos/{id}/source`, declared size and MIME type
- A file name `Trip to Rio.mp4` without a title yields the title `Trip to Rio`
- A declared size above `UPLOAD_MAX_SIZE_BYTES` raises `VIDEO_TOO_LARGE` and persists nothing
- A 10 GiB declaration returns 103 part URLs of 100 MiB
- A `public_id` collision on insert is retried with a new id and succeeds

---

### SI-03.8 — Endpoint POST /videos (Start Upload)

**Description:** Expose upload initiation over HTTP with validation, OpenAPI documentation and the response contract of `### API Contracts → POST /videos`.

**Technical actions:**

1. Create `src/videos/dto/create-video.dto.ts` — `fileName` (1–255), `fileSize` (integer ≥ 1), `contentType` (`^video\/[\w.+-]+$`), optional `title` (1–100)
2. Create response DTOs `src/videos/dto/upload-session.dto.ts` (`UploadSessionDto`, `UploadPartDto`) and `src/videos/dto/video-response.dto.ts` (`VideoResponseDto`, `VideoMetadataDto`, `VideoChannelDto`) with `@ApiProperty`
3. Create `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@Controller('videos')`, `@SkipThrottle()` (throttling stays scoped to auth, per phase-02-auth/TD-08), `POST /videos` → `201` with `@ApiBearerAuth('access-token')` and documented `400`/`401`/`404` responses
4. Register `VideosModule` in `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `POST /videos` | E2E: 201 contract, 400 validation (bad content type), 400 `VIDEO_TOO_LARGE`, 401 without token | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `POST /videos` with a valid body and token returns `201` with `id` (11 chars), `status: "draft"`, `upload.partSize`, `upload.partCount` and `upload.parts[].url`
- `POST /videos` with `contentType: "image/png"` returns `400` with `error: "VALIDATION_ERROR"`
- `POST /videos` with `fileSize` above the configured maximum returns `400` with `error: "VIDEO_TOO_LARGE"`
- `POST /videos` without a token returns `401`
- Every part URL accepts a direct `PUT` of the bytes to object storage — the API never receives the file body

---

### SI-03.9 — Upload Completion and Processing Hand-off

**Description:** Complete the multipart upload server-side, verify the stored size, move the video to `processing` and enqueue the processing job with the TD-08 commit-then-enqueue rule.

**Technical actions:**

1. Implement `VideosService.completeUpload(userId, publicId)` — load the video with its channel; non-owner or unknown → `VIDEO_NOT_FOUND`; status ≠ `draft` → `VIDEO_NOT_DRAFT` (per `### Authorization Matrix`)
2. Finalize storage idempotently — if the source object already exists skip completion; otherwise list parts, missing parts → `UPLOAD_INCOMPLETE` (video stays `draft`), else `completeMultipartUpload` (per `phase-03-videos/TD-02`)
3. Verify `headObject(storage_key).size == size_bytes`; on mismatch delete the object, mark the video `failed` with `processing_error` and raise `UPLOAD_SIZE_MISMATCH`
4. Commit `status = processing`, `upload_id = null` (conditional on `status = draft`), then `VideoProcessingProducer.enqueue(video.id)`; if enqueue throws, revert to `draft` (compensation) and rethrow (per `phase-03-videos/TD-08`)
5. Add `POST /videos/:id/upload/complete` → `202` returning `VideoResponseDto`, documented `401`/`404`/`409`/`400`/`422`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ownership, status guard, incomplete parts, size mismatch, enqueue-failure compensation | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: real DB + MinIO + Redis — job enqueued, status `processing`; compensation reverts to `draft` (spy on producer) | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:id/upload/complete` | E2E: 202 happy path, 400 `UPLOAD_INCOMPLETE`, 404 for another user, 409 when repeated | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- After all parts are uploaded, `POST /videos/:id/upload/complete` returns `202` with `status: "processing"` and a `process-video` job for the video exists in the queue
- Completing before uploading every part returns `400` with `error: "UPLOAD_INCOMPLETE"` and the video stays `draft`
- Completing another channel's video returns `404` with `error: "VIDEO_NOT_FOUND"`
- Completing an already-completed video returns `409` with `error: "VIDEO_NOT_DRAFT"`
- When the queue rejects the job, the video is back in `draft` and a retry of the completion succeeds
- A stored object whose size differs from the declared size leaves the video `failed` and returns `422` with `error: "UPLOAD_SIZE_MISMATCH"`

---

### SI-03.10 — Media Probe Service (ffprobe / ffmpeg)

**Description:** Wrap the FFmpeg binaries: extract typed metadata and render one JPEG frame from a URL without downloading the whole file.

**Technical actions:**

1. Create `src/video-processing/media-probe.parser.ts` — `parseProbeOutput(json)` → `{ durationSeconds, metadata }` (first video stream: width, height, codec, frame rate from `avg_frame_rate`; first audio codec or `null`; `format_name`; `bit_rate`), `null` when no video stream (per `phase-03-videos/TD-05`)
2. Create `src/video-processing/media-probe.service.ts` — `probe(url)` runs `ffprobe -v error -print_format json -show_format -show_streams <url>` via `execFile`; `extractThumbnail(url, atSeconds)` runs `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2pipe -vcodec mjpeg pipe:1` and returns the JPEG `Buffer`; both with a timeout and `maxBuffer`
3. Create `src/test/video-fixture.ts` — generates small MP4 fixtures with `ffmpeg -f lavfi` (`testsrc` + `sine`) and a non-video file for tests

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: video+audio, video-only, no video stream, missing optional fields | `src/video-processing/media-probe.parser.spec.ts` |
| `MediaProbeService` | Integration: real ffprobe/ffmpeg over a presigned MinIO URL — duration ≈ fixture length, 320×240 metadata, JPEG magic bytes | `src/video-processing/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (ffmpeg in image), SI-03.3 (presigned URLs for the integration test)

**Acceptance criteria:**

- Probing a 3-second 320×240 H.264 fixture returns a duration within ±0.1s of 3, width 320, height 240, video codec `h264`
- Probing a file without a video stream returns `null` metadata
- Extracting a thumbnail returns bytes starting with the JPEG marker `FF D8`
- Probing an unreachable URL rejects with an error (never resolves silently)

---

### SI-03.11 — Video Processing Service and Queue Processor

**Description:** Consume `process-video` jobs: probe the source, generate and store the thumbnail, and move the video to `ready`, or to `failed` after the final attempt / on unrecoverable media.

**Technical actions:**

1. Add to `VideosService`: `findById(id)`, `markReady(id, { durationSeconds, metadata, thumbnailKey })` (sets `processed_at`, clears `processing_error`), `markFailed(id, message)` — both conditional on `status = processing` (per `phase-03-videos/TD-08`)
2. Create `src/video-processing/video-processing.service.ts` — `processVideo(videoId)`: skip unless `processing`; presign an internal GET URL; probe; no video stream → `UnrecoverableError`; thumbnail at 10% of duration (0 when unknown); `putObject(thumbnails/{id}.jpg)`; `markReady` (per `phase-03-videos/TD-05`)
3. Create `src/video-processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`, `process()` delegates to the service; `@OnWorkerEvent('failed')` calls `markFailed` when the error is unrecoverable or `attemptsMade >= attempts`, logging instead of rethrowing (per `phase-03-videos/TD-08`, `library-refs.md`)
4. Create `src/video-processing/video-processing.module.ts` — imports `VideosModule`, `StorageModule`; providers `MediaProbeService`, `VideoProcessingService`, `VideoProcessingProcessor`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: skip non-processing, unrecoverable on no video stream, thumbnail timestamp rule (mock deps) | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: real DB + MinIO + ffmpeg — fixture becomes `ready` with duration, metadata, thumbnail object | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingProcessor` | Unit: final-attempt / unrecoverable → `markFailed`; intermediate attempt → no status change | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingModule` | Unit: compilation | `src/video-processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.9 (job contract), SI-03.10 (probe)

**Acceptance criteria:**

- Processing a `processing` video whose source is a valid MP4 sets `status = ready`, `duration_seconds`, `metadata`, `thumbnail_key = thumbnails/{id}.jpg` and `processed_at`, and the thumbnail object exists in storage
- Processing a video whose source has no video stream ends with `status = failed` and a `processing_error`, without retries
- A transient failure on a non-final attempt leaves the video in `processing` (it will be retried)
- A job for a video that is not `processing` (e.g., already `ready`) changes nothing

---

### SI-03.12 — Video Worker Entrypoint and Compose Service

**Description:** Run the processor in its own process and container (`video-worker`), sharing config, database and queue setup with the API without starting an HTTP server.

**Technical actions:**

1. Extract shared root setup: `src/config/config-module.options.ts` (`ConfigModule.forRoot` options incl. all namespaces) and `src/database/database.module.ts` (`TypeOrmModule.forRootAsync`), reused by `AppModule` (per `phase-03-videos/TD-04`)
2. Create `src/worker/worker.module.ts` (Config + Database + `QueueModule` + `VideoProcessingModule`) and `src/worker.ts` (`NestFactory.createApplicationContext`, shutdown hooks, startup log)
3. Add `tsconfig.worker.json` (outDir `dist-worker`) and npm scripts `start:worker`, `start:worker:dev` (`nest start --watch --entryFile worker --path tsconfig.worker.json`); ignore `dist-worker` in git and in `tsconfig.json`
4. Add `video-worker` service to `compose.yaml` — same build/volume as `nestjs-api`, command `npm run start:worker:dev`, `restart: unless-stopped`, depends on `db`, `redis`, `minio` healthy

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Integration: compiles and initializes against real DB/Redis/MinIO without an HTTP adapter | `src/worker/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.11

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker`, whose logs show the worker started and listening on the `video-processing` queue
- The `nestjs-api` container does not consume `process-video` jobs (only the worker registers the processor)
- Stopping `video-worker` leaves enqueued jobs waiting; starting it again processes them

---

### SI-03.13 — Read, Stream, Download and Thumbnail Endpoints

**Description:** Serve video details by unique URL and redirect playback, download and thumbnail requests to short-lived presigned URLs, honoring the Phase 03 access policy.

**Technical actions:**

1. Implement `VideosService.findForReader(publicId, requesterUserId?)` — `ready` → anyone; other statuses → only the owner; otherwise `VIDEO_NOT_FOUND` (per `phase-03-videos/TD-07` revision)
2. Implement `VideosService.getPlaybackUrl(publicId, kind: 'stream' | 'download' | 'thumbnail', requesterUserId?)` — non-ready: owner gets `VIDEO_NOT_READY`, others `VIDEO_NOT_FOUND`; download disposition `attachment; filename="<original_filename>"` (per `phase-03-videos/TD-07`)
3. Add `@Public()` handlers `GET /videos/:id` (200 `VideoResponseDto`), `GET /videos/:id/stream`, `GET /videos/:id/download`, `GET /videos/:id/thumbnail` (302 with `Location`), using `@OptionalUser()`; document responses in OpenAPI
4. Map `VideoResponseDto` from the entity: `url = {APP_URL}/videos/{publicId}`, `streamUrl`/`downloadUrl`/`thumbnailUrl` only when `ready`, `processingError` only for the owner

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` read methods | Unit: owner vs anonymous per status, disposition filename | `src/videos/videos.service.spec.ts` |
| `GET /videos/:id`, `/stream`, `/download`, `/thumbnail` | E2E: 200/302/404/409 per status and requester | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 (optional requester), SI-03.9 (statuses), SI-03.11 (thumbnail key)

**Acceptance criteria:**

- `GET /videos/:id` for a `ready` video without a token returns `200` with `status: "ready"`, `durationSeconds`, `metadata`, `url`, `streamUrl`, `downloadUrl`, `thumbnailUrl`
- `GET /videos/:id` for a `draft` video returns `404` anonymously and `200` for the owner
- `GET /videos/:id/stream` for a `ready` video returns `302` whose `Location` is a presigned storage URL
- Following the stream redirect with `Range: bytes=0-1023` returns `206` with 1024 bytes
- `GET /videos/:id/download` redirects to a URL whose response carries `Content-Disposition: attachment` with the original file name
- `GET /videos/:id/stream` for the owner's `processing` video returns `409` with `error: "VIDEO_NOT_READY"`
- `GET /videos/unknownid00` returns `404` with `error: "VIDEO_NOT_FOUND"`

---

### SI-03.14 — End-to-End Upload → Processing → Streaming Pipeline

**Description:** Prove the whole phase across real infrastructure: HTTP upload handshake, direct part uploads to MinIO, queue hand-off, worker processing and streaming.

**Technical actions:**

1. Create `test/video-pipeline.e2e-spec.ts` — boots the API (`AppModule`) and an in-test worker (`createApplicationContext(WorkerModule)`) on the test queue prefix
2. Scenario A: register/login → `POST /videos` (multi-part file: part size overridden to 5 MiB) → `PUT` parts to presigned URLs → complete → poll `GET /videos/:id` until `ready` → assert metadata, thumbnail redirect, stream `206`, download bytes equal the original
3. Scenario B: upload a non-video file with a `video/mp4` content type → poll until `failed` with `processingError`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Upload → process → stream flow | E2E: real DB, MinIO, Redis, ffmpeg, worker | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.12, SI-03.13

**Acceptance criteria:**

- A video uploaded in more than one part through presigned URLs reaches `ready` automatically after completion, with `durationSeconds` > 0 and a thumbnail
- The downloaded bytes are identical to the uploaded file
- A corrupt upload reaches `failed` with a non-empty `processingError`
- Two uploads produce two different `id`s / URLs

---

### SI-03.15 — Documentation: OpenAPI Export, HTTP Examples and CLAUDE.md

**Description:** Bring the contract and AI documentation in line with the shipped code.

**Technical actions:**

1. Regenerate `nestjs-project/openapi.json` with `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`)
2. Add the video flow requests to `nestjs-project/api.http`
3. Update `nestjs-project/CLAUDE.md` — services (`minio`, `redis`, `video-worker`), readiness checks, worker commands, videos module/endpoints, storage/queue test conventions
4. Update root `CLAUDE.md` — Message Queue = BullMQ/Redis, video worker, storage, and the `next-frontend/` status

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Exported spec | Integration: existing `openapi-export.integration-spec.ts` stays green; `/videos` paths present | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.14

**Acceptance criteria:**

- `openapi.json` lists `POST /videos`, `POST /videos/{id}/upload/complete`, `GET /videos/{id}`, `/stream`, `/download`, `/thumbnail`
- Every file, command and endpoint cited in both `CLAUDE.md` files exists in the repository

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in code (`crypto.randomUUID()`) before insert so storage keys can embed it |
| public_id | varchar(11) | unique, not null | `crypto.randomBytes(8)` base64url — the unique URL id (per `phase-03-videos/TD-06`) |
| channel_id | uuid | FK → channels.id, `ON DELETE CASCADE`, not null | Owner channel |
| title | varchar(100) | not null | Defaults to the file name without extension (validation AMB-2) |
| status | enum `videos_status_enum` | not null, default `'draft'`, values `draft`, `processing`, `ready`, `failed` | Processing lifecycle (per `phase-03-videos/TD-08`) |
| original_filename | varchar(255) | not null | Used for the download `Content-Disposition` |
| mime_type | varchar(100) | not null | Declared `video/*` content type |
| size_bytes | bigint | not null | Declared size; number transformer (≤ 2^53) |
| storage_key | varchar(255) | not null | `videos/{id}/source` (per `phase-03-videos/TD-03`) |
| upload_id | varchar(255) | nullable | S3 multipart upload id while `draft`; cleared on completion |
| thumbnail_key | varchar(255) | nullable | `thumbnails/{id}.jpg` once `ready` |
| duration_seconds | double precision | nullable | From ffprobe `format.duration` |
| metadata | jsonb | nullable | `{ width, height, videoCodec, audioCodec, formatName, bitRate, frameRate }` (per `phase-03-videos/TD-05`) |
| processing_error | text | nullable | Last failure reason when `failed` |
| processed_at | timestamptz | nullable | Set when `ready` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many)
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK lookups

**Status transitions:** `draft → processing` (upload completed + job enqueued; reverted to `draft` if enqueue fails) · `draft → failed` (stored size ≠ declared) · `processing → ready` (worker success) · `processing → failed` (unrecoverable media or final attempt exhausted).

---

### API Contracts

All endpoints use the inherited error envelope `{ statusCode, error, message }`. Videos are addressed by `public_id` (`:id` below).

#### POST /videos (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access token>`
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1–255 chars
- fileSize: integer, required — ≥ 1 and ≤ `UPLOAD_MAX_SIZE_BYTES` (10,737,418,240 by default)
- contentType: string, required — matches `^video\/[\w.+-]+$`
- title: string, optional — 1–100 chars; defaults to `fileName` without extension

**Response 201:**
- id: string — 11-char public id
- title: string
- status: `"draft"`
- url: string — `{APP_URL}/videos/{id}`
- upload: object
  - partSize: number (bytes)
  - partCount: number
  - expiresAt: string (ISO-8601) — part URLs expiry (`UPLOAD_URL_EXPIRES_SECONDS`)
  - parts: array of `{ partNumber: number, url: string }` — presigned `PUT` URLs; the client sends bytes `[(n-1)·partSize, n·partSize)` to part `n`

**Error responses:**
- 400 VALIDATION_ERROR: invalid body
- 400 VIDEO_TOO_LARGE: `fileSize` above the configured maximum
- 401: missing/invalid token
- 404 CHANNEL_NOT_FOUND: authenticated user has no channel

#### POST /videos/:id/upload/complete (SI-03.9)

**Request headers:**
- Authorization: Bearer `<access token>`

**Request body:** none — the server lists the uploaded parts itself (per `phase-03-videos/TD-02`)

**Response 202:** `VideoResponse` (see `GET /videos/:id`) with `status: "processing"`

**Error responses:**
- 400 UPLOAD_INCOMPLETE: not every part has been uploaded (video stays `draft`)
- 401: missing/invalid token
- 404 VIDEO_NOT_FOUND: unknown id or video owned by another channel
- 409 VIDEO_NOT_DRAFT: video already completed/processing/ready/failed
- 422 UPLOAD_SIZE_MISMATCH: stored object size differs from the declared size (video becomes `failed`)

#### GET /videos/:id (SI-03.13)

**Request headers:**
- Authorization: Bearer `<access token>` — optional; identifies the owner

**Response 200 (`VideoResponse`):**
- id: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- url: string — `{APP_URL}/videos/{id}`
- originalFilename: string
- mimeType: string
- sizeBytes: number
- durationSeconds: number | null
- metadata: `{ width, height, videoCodec, audioCodec, formatName, bitRate, frameRate }` | null
- thumbnailUrl / streamUrl / downloadUrl: string | null — `{APP_URL}/videos/{id}/thumbnail|stream|download` when `ready`, else `null`
- processingError: string | null — only for the owner; `null` for others
- channel: `{ nickname: string, name: string }`
- createdAt: string (ISO-8601)
- processedAt: string (ISO-8601) | null

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id, or not `ready` and the requester is not the owner

#### GET /videos/:id/stream · GET /videos/:id/download · GET /videos/:id/thumbnail (SI-03.13)

**Request headers:**
- Authorization: Bearer `<access token>` — optional

**Response 302:**
- Location: presigned storage GET URL valid for `DOWNLOAD_URL_EXPIRES_SECONDS` (per `phase-03-videos/TD-07`)
  - `stream`: inline, `Content-Type` = `mime_type`; storage answers `Range` requests with `206 Partial Content`
  - `download`: `Content-Disposition: attachment; filename="<original_filename>"`
  - `thumbnail`: `image/jpeg`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id, or not `ready` and requester is not the owner
- 409 VIDEO_NOT_READY: owner requesting a video that is not `ready`

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos | | ✓ | | Video is created in the caller's own channel |
| POST /videos/:id/upload/complete | | ✓ | ✓ | Non-owners get `404 VIDEO_NOT_FOUND` (no existence leak) |
| GET /videos/:id | ✓ | optional | | `ready` → anyone; other statuses → owner only (TD-07 revision) |
| GET /videos/:id/stream | ✓ | optional | | `ready` only; owner of a non-ready video gets `409` |
| GET /videos/:id/download | ✓ | optional | | Same rule as `stream` |
| GET /videos/:id/thumbnail | ✓ | optional | | Same rule as `stream` |

All video routes carry `@SkipThrottle()` — rate limiting remains scoped to auth endpoints (phase-02-auth/TD-08), and a player issues many range requests.

---

### Error Catalog

**Error response format:** inherited from Phase 02 — `{ statusCode: number, error: string, message: string }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `public_id`; owner-only operation by another user; non-ready video read by a non-owner |
| VIDEO_TOO_LARGE | 400 | Video exceeds the maximum upload size | `POST /videos` with `fileSize` > `UPLOAD_MAX_SIZE_BYTES` |
| CHANNEL_NOT_FOUND | 404 | Channel not found | `POST /videos` by a user without a channel |
| VIDEO_NOT_DRAFT | 409 | Video upload is already completed | `POST /videos/:id/upload/complete` when status ≠ `draft` |
| VIDEO_NOT_READY | 409 | Video is not ready yet | Owner calls `stream`/`download`/`thumbnail` before `ready` |
| UPLOAD_INCOMPLETE | 400 | Not all upload parts were received | Completion with missing parts |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | Stored object size ≠ `size_bytes` after completion |

Worker-side failure reasons are not HTTP errors; they are stored in `videos.processing_error` (e.g., `Source has no video stream`, ffprobe/ffmpeg error output).

---

### Events/Messages

#### video.process

Queue `video-processing`, job name `process-video`.

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingProducer` in the API, called by `VideosService.completeUpload` after committing `status = processing` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)
**Consumer:** `VideoProcessingProcessor` in the `video-worker` container → `VideoProcessingService.processVideo` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
**Trigger:** successful `POST /videos/:id/upload/complete`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-08`) — `jobId = videoId` de-duplicates while the job record exists; `attempts: 3`, exponential backoff 5s; `UnrecoverableError` (no video stream) skips retries; `removeOnComplete: true`, `removeOnFail: 1000`; the consumer is idempotent (ignores videos not in `processing`, deterministic thumbnail key). Final failure → `status = failed` + `processing_error`.

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (env contract for credentials/hosts)
│   ├── SI-03.3 — + SI-03.1 (storage config + MinIO)
│   └── SI-03.6 — + SI-03.1 (queue config + Redis)
SI-03.4 (root — entity + migration)
SI-03.5 (root — guard change)

SI-03.3 + SI-03.4 + SI-03.6
└── SI-03.7 (initiation service)
    └── SI-03.8 (POST /videos)
        └── SI-03.9 (completion + enqueue)

SI-03.2 + SI-03.3
└── SI-03.10 (media probe)

SI-03.9 + SI-03.10
└── SI-03.11 (processing service + processor)
    └── SI-03.12 (worker entrypoint + Compose service)

SI-03.5 + SI-03.9 + SI-03.11
└── SI-03.13 (read / stream / download / thumbnail)

SI-03.12 + SI-03.13
└── SI-03.14 (pipeline e2e)
    └── SI-03.15 (docs)
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15

## Deliverables

- [ ] SI-03.1 — Dependencies, Configuration Namespaces and Env Contract
- [ ] SI-03.2 — Docker Compose Infrastructure: Object Storage, Queue Broker and FFmpeg
- [ ] SI-03.3 — Storage Module (S3 Client, Multipart and Presigned URLs)
- [ ] SI-03.4 — Video Entity, Migration and Unique Public Id
- [ ] SI-03.5 — Optional Requester Identity on Public Routes
- [ ] SI-03.6 — Queue Foundation and Video Processing Producer
- [ ] SI-03.7 — Video Upload Initiation Service (Draft Pre-registration)
- [ ] SI-03.8 — Endpoint POST /videos (Start Upload)
- [ ] SI-03.9 — Upload Completion and Processing Hand-off
- [ ] SI-03.10 — Media Probe Service (ffprobe / ffmpeg)
- [ ] SI-03.11 — Video Processing Service and Queue Processor
- [ ] SI-03.12 — Video Worker Entrypoint and Compose Service
- [ ] SI-03.13 — Read, Stream, Download and Thumbnail Endpoints
- [ ] SI-03.14 — End-to-End Upload → Processing → Streaming Pipeline
- [ ] SI-03.15 — Documentation: OpenAPI Export, HTTP Examples and CLAUDE.md

**Phase deliverables (project-plan.md):** upload de até 10GB funcional · processamento automático do vídeo · streaming funcionando · URLs únicas geradas.

**Follow-up task (out of scope, validation AMB-3):** cleanup of abandoned uploads — abort endpoint and/or storage lifecycle rule `AbortIncompleteMultipartUpload` + stale `draft` sweeper.

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e -- --runInBand`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
