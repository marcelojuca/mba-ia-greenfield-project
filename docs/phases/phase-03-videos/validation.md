---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 8
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-19T21:20:00-06:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T21:06:25-06:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-19T20:46:54-06:00"
issues:
  - id: AMB-1
    status: open
    summary: "Who may read/stream/download a video in Phase 03 (publication is Phase 04)?"
  - id: AMB-2
    status: open
    summary: "Draft title at pre-registration — required input or derived?"
  - id: AMB-3
    status: open
    summary: "Abandoned uploads (draft never completed) — cleanup in scope?"
  - id: AMB-4
    status: open
    summary: "Queue isolation in tests vs the always-running video-worker container"
  - id: MD-1
    status: open
    summary: "No library/image versions pinned for queue, storage SDK, Redis, MinIO"
  - id: MD-2
    status: open
    summary: "Canonical env key set for storage/queue/upload limits not decided"
  - id: DG-1
    status: open
    summary: "Global JWT guard never sets request.user on @Public routes"
  - id: ICC-1
    status: open
    summary: "Testing guide prescribes local-FS storage adapter; TD-03 uses MinIO"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — "Reprodução via streaming" and "Download do vídeo pelo usuário" do not say *which* users may read a video, and the publication/visibility rules are explicitly Phase 04 ("Visibilidade do vídeo", "Fluxo de rascunho → publicação"). The project overview says anonymous users watch freely, but a Phase 03 video never becomes "published". Must decide, for `GET` details / stream / download / thumbnail: (a) owner only until Phase 04; (b) anyone holding the unique URL once `status = ready` (unlisted-like), owner sees any status; (c) authenticated users only.
- **AMB-2** — "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" — the draft needs a `title`, but editing video information is Phase 04. Is the title a required client input at initiation, or derived (e.g., from the file name)? Which length limit?
- **AMB-3** — TD-02 notes abandoned multipart uploads leave orphan parts and `draft` rows. No capability or TD says whether cleanup (abort endpoint, storage lifecycle rule, scheduled sweeper) belongs to this phase.
- **AMB-4** — TD-04 runs a `video-worker` Compose service permanently, and tests share the same Redis/DB (inherited convention: shared `streamtube` DB, `--runInBand`). With one queue name, the long-running container competes with the in-test worker for test jobs, making integration/e2e assertions nondeterministic. Test isolation strategy for the queue is undefined.

### Missing Decisions

- **MD-1** — `## Decisions Index` lists `Libraries: —` for every phase-03 TD, yet TD-01 (BullMQ), TD-02/03/07 (S3 client + presigner), TD-03 (MinIO image) and TD-01 (Redis image) introduce new dependencies. Versions compatible with NestJS 11 / Node 25 must be pinned (and distilled in `library-refs.md`) before planning SIs.
- **MD-2** — TD-03 names `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET` but not credentials/region, the Redis connection keys, or the upload/stream parameters (max size, part size, URL TTLs) from TD-02/TD-07. The env key set is a cross-component contract (Joi schema + `compose.yaml` + `.env.example` + config namespaces) and is undecided.

### Dependency Gaps

- **DG-1** — Inherited convention: the global `JwtAuthGuard` returns early on `@Public()` routes without inspecting the `Authorization` header, so `request.user` is never set there. Any resolution of AMB-1 that lets a public endpoint behave differently for the owner (e.g., owner sees non-ready videos) needs the guard to attach the user optionally. No prior-phase deliverable covers this.

### Inherited Constraint Conflicts

- **ICC-1** — `testing-guide-nestjs-project/references/external-systems.md` prescribes "Object Storage — Local Filesystem … use the local filesystem adapter" for tests, while phase-03-videos/TD-03 fixes S3/MinIO (running in Compose) as the storage and TD-05 requires presigned HTTP URLs that a filesystem adapter cannot produce. The same guide says the queue is real in Docker; storage must follow the same rule or be explicitly overridden.

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
