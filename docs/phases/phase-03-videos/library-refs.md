---
libs:
  bullmq:
    version: "^6.7.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-19T23:27:22-06:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-19T23:27:22-06:00"
  ioredis:
    version: "^5.11.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-20T00:10:00-06:00"
  "@aws-sdk/client-s3":
    version: "^3.1173.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-19T23:27:22-06:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1173.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-19T23:27:22-06:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T23:27:18-06:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase. Pulled from Context7 (HTTP API `context7.com/api/v1`, same corpus the context7 MCP server serves — the MCP server was not configured in this session's `.mcp.json`). Versions match the npm registry on the fetch date and the compatibility of the installed stack (`@nestjs/core@^11`, Node 25).

Infrastructure images pinned alongside (no Context7 entry — verified with `docker pull`):

| Image | Tag | Notes |
|-------|-----|-------|
| Redis (BullMQ broker) | `redis:7.4-alpine` | BullMQ requires Redis ≥ 6.2; run with `--appendonly yes` and `--maxmemory-policy noeviction` so queued jobs survive restarts and are never evicted. |
| MinIO (S3-compatible storage) | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | Upstream `minio/minio` (Docker Hub) and `quay.io/minio/minio` no longer serve images; `pgsty/minio` is the community build of the same MinIO source. Ships `mc` and `curl` (healthcheck: `curl -f http://localhost:9000/minio/health/live`). |
| FFmpeg | Debian bookworm `ffmpeg` (`7:5.1.x`) | Installed via `apt` in `nestjs-project/Dockerfile.dev`; provides `ffmpeg` and `ffprobe`. |

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7, trust 9.2). Maps to `phase-03-videos/TD-01`, `TD-08`.

### Job ids — de-duplication (TD-08 enqueue rule)

"The id must be unique within the queue; otherwise, the job is ignored. Avoid ':' and digit-only strings." A UUID video id is a valid `jobId`. Caveat from the throttle pattern: *if `removeOnComplete`/`removeOnFail` removes the job, a new job with the same id can be added again* — de-duplication only holds while the job record exists.

```typescript
await queue.add('process-video', { videoId }, { jobId: videoId });
```

### Retries and permanent failures

`attempts` + `backoff` (`{ type: 'exponential', delay: 5000 }`) retry thrown errors. Throwing `UnrecoverableError` "moves the job to the failed set without retries, overriding any attempts settings":

```typescript
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('Source has no video stream');
```

A job is definitively failed when `job.attemptsMade >= (job.opts.attempts ?? 1)` in the worker `failed` event, or when the error is an `UnrecoverableError`.

### Connections and prefix

**v6 driver note (found at install time, SI-03.1):** `bullmq@6` no longer depends on `ioredis`; it is an *optional peer* loaded lazily ("BullMQ could not load the optional 'ioredis' package. Install it with `npm install ioredis`, or provide a different Redis client"). Since the project connects with plain `{ host, port }` options, `ioredis@^5.11.1` is installed explicitly alongside `bullmq`.

Workers need a connection with `maxRetriesPerRequest: null` (BullMQ sets it for connections it creates from options). The Redis key `prefix` (default `bull`) namespaces queues: "All components accessing the same queue must use the same prefix" — used to isolate test queues (`QUEUE_PREFIX`, TD-09). `queue.obliterate({ force: true })` wipes a queue (tests only).

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7, trust 9.7). **Pinned to `^11.0.5`** (TD-01 revision): `12.x` is ESM-only and breaks the CommonJS/ts-jest toolchain; `11.0.5` is CommonJS with peers `bullmq ^3||^4||^5||^6`, `@nestjs/common|core ^10||^11`. The API below is identical in both majors.

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
    prefix: cfg.prefix,
  }),
});
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE });
// producer
constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}
```

Consumer — must extend `WorkerHost`; a thrown error fails the job and it is retried per job options; `@OnWorkerEvent('failed')` handlers are bound to the worker instance:

```typescript
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* final-attempt bookkeeping */ }
}
```

`this.worker` is available only after `onModuleInit` registration (e.g., in `onApplicationBootstrap`). `getQueueToken(name)` returns the DI token for tests (`module.get<Queue>(getQueueToken(name))`).

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7). Maps to `phase-03-videos/TD-02`, `TD-03`, `TD-05`, `TD-07`.

- Reuse one `S3Client` per endpoint/credentials ("Avoid instantiating S3Client inside loops"). The storage service holds two: one with `S3_ENDPOINT` (internal network calls) and one with `S3_PUBLIC_ENDPOINT` used **only** for presigning (signing is local — no request is sent).
- MinIO requires path-style addressing: `new S3Client({ endpoint, region, credentials, forcePathStyle: true })`.
- Multipart commands used: `CreateMultipartUploadCommand` → `{ UploadId }`; `UploadPartCommand` (presigned, `PartNumber` 1..10000); `ListPartsCommand` (paginated, `MaxParts` ≤ 1000, `NextPartNumberMarker`) → `Parts[{ PartNumber, ETag, Size }]`; `CompleteMultipartUploadCommand` with `MultipartUpload: { Parts: [{ PartNumber, ETag }] }` in ascending order; `AbortMultipartUploadCommand`; `HeadObjectCommand` → `ContentLength`; `HeadBucketCommand`/`CreateBucketCommand`; `PutObjectCommand` (thumbnail); `GetObjectCommand` supports `Range: 'bytes=0-99'` and `ResponseContentDisposition`/`ResponseContentType` overrides.
- **Checksum defaults (flag):** SDK releases since early 2025 calculate request checksums by default (`requestChecksumCalculation: 'WHEN_SUPPORTED'`). For presigned `UploadPart` URLs consumed by third-party clients and for S3-compatible servers, configure `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` so signed URLs do not demand checksum headers the uploader never sends. Verify against MinIO in the storage integration test.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` → `packages/s3-request-presigner/README.md`. "The expiresIn configuration defaults to 900 seconds if not explicitly provided."

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const url = await getSignedUrl(publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: uploadUrlExpiresSeconds });
const streamUrl = await getSignedUrl(publicClient,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="x.mp4"' }),
  { expiresIn: downloadUrlExpiresSeconds });
```

SigV4 presigned URLs are valid for at most 7 days (24h upload TTL and 1h download TTL are within the limit). The host of the URL is part of the signature — a URL signed for `localhost:9000` must be requested with `Host: localhost:9000`.
