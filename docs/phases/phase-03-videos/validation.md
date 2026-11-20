---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-19T23:42:34-06:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T23:42:34-06:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-19T20:46:54-06:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Who may read/stream/download a video in Phase 03 (publication is Phase 04)?"
    resolved_by: phase-03-videos/TD-07
  - id: AMB-2
    status: resolved
    summary: "Draft title at pre-registration — required input or derived?"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Abandoned uploads (draft never completed) — cleanup in scope?"
    resolved_by: clarification
  - id: AMB-4
    status: resolved
    summary: "Queue isolation in tests vs the always-running video-worker container"
    resolved_by: phase-03-videos/TD-09
  - id: MD-1
    status: resolved
    summary: "No library/image versions pinned for queue, storage SDK, Redis, MinIO"
    resolved_by: library-refs.md
  - id: MD-2
    status: resolved
    summary: "Canonical env key set for storage/queue/upload limits not decided"
    resolved_by: phase-03-videos/TD-09
  - id: DG-1
    status: resolved
    summary: "Global JWT guard never sets request.user on @Public routes"
    resolved_by: clarification
  - id: ICC-1
    status: resolved
    summary: "Testing guide prescribes local-FS storage adapter; TD-03 uses MinIO"
    resolved_by: clarification
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_Revision 1 (dirty, 8 open issues) → `/research` addendum (TD-09) → `/plan-context` re-aggregation → `/plan-resolve` (user answers for AMB-1, AMB-2, AMB-3, ICC-1; Libraries + `library-refs.md`) → revision 2 (clean)._

_Revision 3 (clean) — re-validated after the implementation-time TD-01 revisions (`@nestjs/bullmq` pinned to `^11.0.5` because 12.x is ESM-only; `ioredis` added as BullMQ 6 optional peer). Same Option A, library parameters only; no check fires (no IC/ICC against inherited conventions, capability coverage unchanged)._

- **AMB-1** _(resolved_by phase-03-videos/TD-07 — Revision 2026-11-19)_ — User chose "unlisted-like": `GET /videos/:id`, `/stream`, `/download`, `/thumbnail` are `@Public()` and serve `status = ready` videos to anyone holding the unique URL; the owning channel's user (optional bearer token) also sees details of non-ready videos. Publication/visibility stays in Phase 04.
- **AMB-2** _(resolved_by clarification)_ — User chose "optional, from filename": `title` is optional at initiation (1–100 chars); when omitted it defaults to the uploaded file name without extension, truncated to 100 chars.
- **AMB-3** _(resolved_by clarification)_ — User chose "defer to a separate task": abandoned-upload cleanup (abort endpoint, `AbortIncompleteMultipartUpload` lifecycle rule, stale-draft sweeper) is out of this phase's capability bullets and is recorded as a follow-up task in the plan's Deliverables notes. No code in Phase 03.
- **AMB-4** _(resolved_by phase-03-videos/TD-09)_ — Tests isolate the queue through `QUEUE_PREFIX` (TD-09): a Jest setup file overrides it to a test-only prefix, so the long-running `video-worker` container (default prefix) never consumes test jobs and the in-test worker is the sole consumer.
- **MD-1** _(resolved_by library-refs.md)_ — Libraries pinned on the TDs (`bullmq@^6.7.8`, `@nestjs/bullmq@^12.0.2`, `@aws-sdk/client-s3@^3.1173.0`, `@aws-sdk/s3-request-presigner@^3.1173.0`) and images (`redis:7.4-alpine`, `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, Debian `ffmpeg` 5.1) distilled in `docs/phases/phase-03-videos/library-refs.md` from Context7.
- **MD-2** _(resolved_by phase-03-videos/TD-09)_ — New TD-09 (via `/research` addendum) fixes the discrete env key set for the `storage` and `queue` namespaces, including upload/stream limits.
- **DG-1** _(resolved_by clarification)_ — Follows from AMB-1: `JwtAuthGuard` is extended so that on `@Public()` routes a *valid* bearer token still populates `request.user` (invalid/missing tokens are ignored, never rejected). Planned as an explicit SI with unit + e2e coverage; existing public auth endpoints keep their behavior.
- **ICC-1** _(resolved_by clarification)_ — User chose "real MinIO in tests": storage integration/e2e tests hit the MinIO Compose service, same rule as the queue. The testing guide's `references/external-systems.md` "Object Storage" section is updated during implementation to document MinIO instead of the local-filesystem adapter.
