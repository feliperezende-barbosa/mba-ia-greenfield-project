---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T11:46:56-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T11:45:08-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-08T11:46:49-03:00"
issues:
  - id: IC-1
    status: resolved
    resolved_by: phase-03-videos/TD-08
    summary: "TD-08 draft→error and TD-02 oversize/complete-failure states undefined"
  - id: IC-2
    status: resolved
    resolved_by: phase-03-videos/TD-08
    summary: "TD-08 'error only when no attempts remain' contradicts UnrecoverableError"
  - id: AMB-1
    status: resolved
    resolved_by: phase-03-videos/TD-05
    summary: "TD-05 thumbnail frame-time rule ambiguous (no 'small clip' threshold)"
  - id: AMB-2
    status: resolved
    resolved_by: phase-03-videos/TD-11
    summary: "Video read surface (status, thumbnail access) unassigned between Ph03/Ph04"
  - id: AMB-3
    status: resolved
    resolved_by: phase-03-videos/TD-08
    summary: "Oversize criterion on completion: declared sizeBytes vs fixed 10 GiB limit"
  - id: MD-1
    status: resolved
    resolved_by: phase-03-videos/TD-10
    summary: "No TD for upload-init input contract (title, filename, content type, ext)"
  - id: MD-2
    status: resolved
    resolved_by: phase-03-videos/TD-02
    summary: "No TD for abandoned multipart upload / stuck draft cleanup"
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

### Non-blocking notes (outside the issue taxonomy — not counted in `issue_count`)

- **Earlier fixes re-verified against the current decisions doc (run 3).**
  - IC-1 / IC-2: TD-08 Revisions give the completion order (`CompleteMultipartUpload` → `HeadObject` → `draft → processing` → publish) and the failure-handler condition `UnrecoverableError || attemptsMade >= opts.attempts`. `library-refs.md` confirms in the BullMQ 6.5.3 source that `attemptsMade` already counts the failed attempt when `failed` fires, so the condition is correct.
  - AMB-3: the completion size check uses the actual `ContentLength` against the fixed 10 GiB cap only (`> cap` → `FILE_TOO_LARGE`/`413`; `0` → `EMPTY_FILE`/`422`). Declared `sizeBytes` only plans the part count. This agrees with TD-10 (`sizeBytes` 1…10 GiB) and TD-02 (64 MiB parts, ≤ 160 parts).
  - AMB-1 (TD-05 rule is total: `min(10%, 10s)`, `0s` fallback), AMB-2 (TD-11 owner-only `GET /videos/:publicId`, non-owner `404`), MD-1 (TD-10), MD-2 (TD-02 Revision with `MINIO_API_STALE_UPLOADS_EXPIRY`, confirmed in `library-refs.md`; orphan drafts deferred to Phase 04): all hold.
- **HTTP statuses and error codes across revisions are consistent:** `409` (completion of a non-`draft` video; stream/download of a non-`ready` video), `413`/`FILE_TOO_LARGE`, `422`/`EMPTY_FILE`, `503`/`ENQUEUE_FAILED`, `302` (stream/download), `404` (non-owner read). The transition table in the TD-08 Decision (`draft → error` for an "unusable" object) covers both the oversize and empty cases. No state is left without an owner: `draft`→API, `processing`→worker, publish failure→API compensation, non-retriable media failure→`failed` handler.
- **context.md ↔ decisions doc sync (scripted comparison, read-only).** For TD-01…TD-11, every `**Recommendation:**`, every `**Libraries:**` line and all 7 `**Revisions:**` bullets (TD-01, TD-02, TD-03 ×2, TD-05, TD-08 ×2) are present verbatim in context.md. The Decisions Index "Last revision" rows are current, including the TD-08 IC-2/AMB-3 revision. Capability Coverage matches each TD's `Capability:` field (TD-09 `Transversal — covers` = 6 bullets). `sources_mtime` of context.md matches the files on disk (decisions doc `11:45:08`, `library-refs.md` `11:46:49`); context.md (`11:46:56`) is newer than both, so it is not stale.
- **Capability coverage.** All 9 `Fase 03` bullets of `docs/project-plan.md` appear literally in `## Scope` and `## Capability Coverage`, each mapped to ≥1 decided TD; no TD is `pending`.
- **Library consistency (`library-refs.md` vs TDs).** Pins agree: `@nestjs/bullmq ^11.0.5` (12.x is ESM-only), `bullmq ^6.5.3`, `ioredis ^5.11.1`, `@aws-sdk/* ^3.1161.0`, `redis:7-alpine`, `chainguard/minio:latest`, Debian `ffmpeg`. Every Library of TD-01/02/03/04/05/07/08 is covered. The base image `node:25.6.0-slim` matches `nestjs-project/Dockerfile.dev`. The BullMQ details (`UnrecoverableError`, `jobId` as a UUID, `attempts: 3` with 5 s exponential backoff ⇒ 5 s/10 s waits, `noeviction`) agree with TD-01/TD-08.
- **Check 8 / UI / ICC.** Single phase-scope doc for Phase 03 (`count == 1`), so cross-slice checks are suppressed. `next-frontend` is deferred, so UIG-N, the Frontend-orphan IC and the shared-types contract-sync MD do not apply. No ICC-N: TD-07 `@Public()` with the global JWT guard, domain exceptions through the Phase 02 filter (arbitrary `httpStatus`), class-validator DTOs, migration-based `videos` table, and the TD-06 retry pattern (`23505`, mirrors `ChannelsService`) all agree with the inherited decisions. Phase 02 delivers the channel the video belongs to, so there is no dependency gap. No custom rules (`docs/rules/plan-validate/` absent).
- **Docker `localhost` rule (checked, not raised).** TD-03 documents the single exception (`S3_PUBLIC_ENDPOINT`, because the presigned signature covers the host). Internal calls use `S3_ENDPOINT=http://minio:9000`, the worker signs against `S3_ENDPOINT` (TD-05), tests override `S3_PUBLIC_ENDPOINT` (TD-03/TD-09), and Redis uses the service name.
- **Residual caveats for `/plan-build` and implement (not issues):**
  - TD-02's Decision body says the "declared size is re-verified with `HeadObject`", and TD-02's Option B con says "enforceable on the declared value". The TD-08 Revision (`ContentLength` vs fixed cap, no mismatch rejection) is the later, explicit rule and governs. Neither text is embedded in context.md, so plan-build only sees the TD-08 Revision. An optional one-line TD-02 Revision would remove the wording drift.
  - Failure-handler gap: a job that fails through BullMQ's stalled-job path (e.g. worker OOM/crash during FFmpeg) may not increment `attemptsMade`, so the `failed` handler might not mark `error`. TD-08 Option A accepts that handling of lost/crashed work is limited (reconciler Option B deferred). Cover it with a TD-09 test, or at least an `execFile` timeout, instead of assuming it.
  - Completion handler: the `draft → error` write for `FILE_TOO_LARGE`/`EMPTY_FILE` must be committed before the exception is thrown (not inside a transaction that rolls back on throw).
  - Context7 was unavailable, so `library-refs.md` is built from npm/official docs/source (CLAUDE.md expects Context7; re-confirm when available). `chainguard/minio` entrypoint, credentials and healthcheck tooling, MinIO behaviour with the checksum settings, and `ffprobe`/`ffmpeg` behaviour on real presigned inputs are marked **Unverified** (covered by TD-09 tests). `chainguard/minio:latest` is a mutable tag.
  - The TD-03 body still says CORS is enabled through "`MINIO_API_CORS_ALLOW_ORIGIN` and `ETag` exposure"; its Revision corrects this and governs.
- **Scope-of-reads deviation.** The stage spec says to read only `context.md`. The decisions doc, `library-refs.md`, `docs/project-plan.md`, `nestjs-project/src` and `Dockerfile.dev` were also read to re-verify sync and the revisions' status codes, because Decision bodies (parameters, error codes) are not embedded in context.md.

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-08)_ — TD-08 revised: transition table and completion order made explicit (oversize → `draft → error`, storage failure keeps `draft`, publish failure `processing → error` + `503`, non-`draft` completion `409`).
- **IC-2** _(resolved_by phase-03-videos/TD-08)_ — TD-08 revised: the worker's `failed` handler sets `processing → error` when the error is an `UnrecoverableError` or `job.attemptsMade >= job.opts.attempts`; otherwise the video stays `processing` while BullMQ retries.
- **AMB-1** _(resolved_by phase-03-videos/TD-05)_ — TD-05 thumbnail frame time fixed to `min(10% of duration, 10s)` with a `0s` fallback.
- **AMB-2** _(resolved_by phase-03-videos/TD-11)_ — Phase 03 ships an owner-only `GET /videos/:publicId` (status, metadata, presigned thumbnail URL); public pages/listings stay in Phases 04–05.
- **AMB-3** _(resolved_by phase-03-videos/TD-08)_ — TD-08 revised: completion compares the actual `HeadObject` `ContentLength` with the fixed 10 GiB cap (`> cap` → `FILE_TOO_LARGE`, HTTP `413`; `0` → `EMPTY_FILE`, HTTP `422`); declared `sizeBytes` only plans the part count and no mismatch is rejected; `size_bytes` persists the actual length.
- **MD-1** _(resolved_by phase-03-videos/TD-10)_ — Upload-init payload, media-type allow-list and download filename decided.
- **MD-2** _(resolved_by phase-03-videos/TD-02)_ — Abandoned multipart uploads expire server-side (`MINIO_API_STALE_UPLOADS_EXPIRY`, default 24h); orphan drafts left to Phase 04.
