---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-19T19:26:53-06:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T23:27:18-06:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-19T20:46:54-06:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-11-19T20:46:54-06:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-19T20:46:54-06:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-19T20:46:54-06:00"
  docs/phases/phase-02-auth/context.md: "2026-11-19T20:46:54-06:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-19T19:26:53-06:00"
  .claude/skills/testing-guide-nestjs-project/references/external-systems.md: "2026-11-19T19:26:53-06:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Categorias, edição de informações do vídeo, visibilidade (público/unlisted), fluxo rascunho → publicação, painel do canal e página pública (Fase 04); página de visualização, comentários, likes (Fases 05+); interface de vídeo no `next-frontend/`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — video UI (upload screen, player) is outside this phase's scope; Cross-layer TDs fix the contract for a later frontend phase.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta (videos belong to the user's channel created in Fase 02; endpoints are protected by the Fase 02 global JWT guard).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — users, channels (1:1), JWT guard, error envelope.
- **Phase 04:** Gerenciamento de Vídeos e Canal — edição de vídeo, visibilidade, rascunho → publicação, painel, página pública do canal.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ on Redis) | bullmq@^6.7.8, @nestjs/bullmq@^12.0.2 |
| phase-03-videos/TD-02 | phase | Cross-layer | Large-File Upload Protocol (up to 10GB) | decided | C (S3 multipart with presigned part URLs) | @aws-sdk/client-s3@^3.1173.0, @aws-sdk/s3-request-presigner@^3.1173.0 |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Layout and Endpoint Strategy | decided | A (single private bucket, prefixed keys, app-provisioned) | @aws-sdk/client-s3@^3.1173.0 |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Runtime | decided | A (same codebase, separate entrypoint + Compose service) | — |
| phase-03-videos/TD-05 | phase | Backend | Metadata Extraction and Thumbnail Generation | decided | A (ffprobe/ffmpeg CLI via execFile over presigned URL) | — (system ffmpeg 5.1, Debian apt) |
| phase-03-videos/TD-06 | phase | Backend | Unique Video URL Identifier | decided | B (11-char base64url `public_id`) | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Streaming and Download Delivery | decided | B (302 to presigned GET URLs) | @aws-sdk/s3-request-presigner@^3.1173.0 |
| phase-03-videos/TD-08 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (draft → processing → ready / failed) | — |
| phase-03-videos/TD-09 | phase | Backend | Environment Variable Contract for Storage, Queue and Upload Limits | decided | A (discrete keys in `storage`/`queue` namespaces) | — |
| openapi-docs-nestjs/TD-01 | correlated (ad-hoc) | Backend | OpenAPI Documentation Tooling | decided | A (@nestjs/swagger + CLI plugin) | @nestjs/swagger |
| openapi-docs-nestjs/TD-02 | correlated (ad-hoc) | Backend | OpenAPI Spec Artifact Strategy | decided | C (Runtime UI + exported openapi.json) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)
- openapi-docs-nestjs — `docs/decisions/technical-decisions-openapi-docs-nestjs.md` (scope_type: ad-hoc, `related_phases: []`; correlated because every new controller must be documented and exported to `nestjs-project/openapi.json`)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-09 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-08, phase-03-videos/TD-09 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04, phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — it is the only option with an official NestJS 11 integration and gives retries/backoff/unrecoverable-failure semantics out of the box, which the failure lifecycle (TD-08) relies on. Redis is a single lightweight container and matches the diagram's separate "Message Queue" container. The dual-write risk (DB commit + enqueue) is handled by the ordering/compensation rule in TD-08 instead of a transactional queue.
**Libraries:** bullmq@^6.7.8, @nestjs/bullmq@^12.0.2

### phase-03-videos/TD-02

**Recommendation:** S3 multipart with presigned part URLs — the only option that both supports 10GB and keeps the API out of the data path. Server-side `ListParts` keeps the client contract minimal. Parameters: max size 10 GiB (10,737,418,240 bytes) declared at initiation and validated; part size 100 MiB, raised to `ceil(size / 10,000)` if needed; part URLs valid for 24h; after completion the API checks the stored object size equals the declared size.
**Libraries:** @aws-sdk/client-s3@^3.1173.0, @aws-sdk/s3-request-presigner@^3.1173.0

### phase-03-videos/TD-03

**Recommendation:** A private single bucket with deterministic, id-based keys (`videos/{videoId}/source`, `thumbnails/{videoId}.jpg`), bucket ensured at startup by API and worker, internal `S3_ENDPOINT` for calls and `S3_PUBLIC_ENDPOINT` for signing client URLs; `forcePathStyle: true` for MinIO.
**Libraries:** @aws-sdk/client-s3@^3.1173.0

### phase-03-videos/TD-04

**Recommendation:** Same NestJS codebase with a separate `src/worker.ts` entrypoint (`createApplicationContext`) running as a `video-worker` Compose service from the same image (with `ffmpeg`), keeping the `Video` entity and storage logic single-sourced.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** System `ffprobe`/`ffmpeg` invoked with `execFile`, reading the source through a presigned URL (HTTP range reads — no full download). Thumbnail at 10% of duration (0 when unknown), JPEG 1280px wide preserving aspect ratio; persisted metadata = duration, width, height, video codec, audio codec (nullable), container format, bit rate, frame rate. A file with no video stream is a permanent failure (TD-08).
**Libraries:** — (system ffmpeg 5.1, Debian apt)

### phase-03-videos/TD-06

**Recommendation:** A random 11-char base64url `public_id` (`crypto.randomBytes(8)`) with a DB unique index and regenerate-on-collision retry; never changes when titles are edited in Phase 04.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** API authorizes and answers `302` to a short-lived (1h) presigned GET URL — inline for `/stream`, `attachment` disposition for `/download`, same mechanism for `/thumbnail`; storage serves `Range`/`206` natively.
**Libraries:** @aws-sdk/s3-request-presigner@^3.1173.0
**Revisions:**
- 2026-11-19 — Access policy fixed for Phase 03 (validation AMB-1): details, stream, download and thumbnail are `@Public()` for `status = ready`; the owner (optional bearer token) also reads non-ready details. Rationale: Phase 04 owns publication/visibility; the unguessable `public_id` behaves like an unlisted link.

### phase-03-videos/TD-08

**Recommendation:** Four states (`draft → processing → ready | failed`); 3 attempts with exponential backoff (5s base); no-video-stream media throws `UnrecoverableError`; final failure stores `processing_error`. Commit `processing` first, then enqueue with `jobId = video id`; on enqueue failure revert to `draft`. Worker idempotent (skips videos not in `processing`).
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Discrete keys mirroring `DB_*`/`MAIL_*`: `storage` namespace (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `UPLOAD_MAX_SIZE_BYTES`, `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_URL_EXPIRES_SECONDS`, `DOWNLOAD_URL_EXPIRES_SECONDS`) and `queue` namespace (`REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`), each validated by Joi; defaults point to Compose service names.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` with the CLI plugin (`classValidatorShim: true`) inferring request schemas from class-validator DTOs.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Keep the runtime Swagger UI and the committed, exported `openapi.json` (regenerated by `npm run openapi:export`).
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** `@nestjs/config` — official, core-team-maintained, `registerAs()` factories shared with the TypeORM CLI.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi validation schema via `ConfigModule.forRoot({ validationSchema })`.
**Libraries:** `joi`

### phase-01-configuracao-base/TD-03

**Recommendation:** Namespaced configuration with `registerAs`, injected as `ConfigType<typeof xxxConfig>`.
**Libraries:** —

### phase-02-auth/TD-02

**Recommendation:** Custom global JWT guard (`@nestjs/jwt`), `@Public()` opt-out.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer DTOs with the global `ValidationPipe`.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom domain exception filter returning `{ statusCode, error, message }` with machine-readable domain codes.
**Libraries:** —

## Inherited Conventions

- Config via `registerAs(name, ...)` namespaces in `src/config/`, validated by the Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only via generated migrations. _(from phase 01)_
- Compose service names as hosts (`db`, `mailpit`, …), never `localhost`. _(from phase 01)_
- Global `JwtAuthGuard` (`APP_GUARD`); every endpoint protected unless `@Public()`; `@CurrentUser()` yields `JwtPayload { sub, email }`. _(from phase 02)_
- Services throw `DomainException` subclasses; `DomainExceptionFilter` maps them to `{ statusCode, error, message }`. _(from phase 02)_
- Each user owns exactly one channel (`channels.user_id` unique), created at registration by `ChannelsService`. _(from phase 02)_
- Tests run in the container with `--runInBand`; integration/e2e share the `streamtube` DB. _(from phase 02)_
- Controllers carry `@ApiTags`/`@ApiOperation`/`@ApiResponse` with `ApiErrorEnvelope`; `openapi.json` is exported and committed. _(from openapi-docs-nestjs)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | Delivered later by the `phase-02-auth-frontend` slice; not related to this phase. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (mocked repo) + Integration (DB contract) |
| Service with DB only | Integration |
| Service with side-effect dep (storage, queue) | Integration against the real system — queue = real Redis/BullMQ, storage = real MinIO from Compose (validation ICC-1 resolution overrides the guide's local-filesystem adapter) |
| Module with configured imports (`BullModule.registerQueue`, etc.) | Unit: compilation test |
| Controller | E2E only |
| DTO | E2E: one validation wiring test per endpoint |
| Queue consumer / processor (`artifacts/future-types.md`) | Unit (mocked deps) + Integration (real DB/storage) |

### next-frontend

_Deferred subproject — no video UI in this phase._
