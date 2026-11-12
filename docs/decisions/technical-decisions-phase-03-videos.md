---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-08
scope_description: "Backend foundation for video ingestion: object storage organisation, 10GB upload strategy, background-processing queue and worker, media metadata/thumbnail extraction, unique video URL, streaming/download delivery, status lifecycle and real-infrastructure testing."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (draft pre-registration, direct-to-storage upload handshake, processing job publication), the video worker (queue consumer + FFmpeg), the new Compose services (object storage, queue, worker) and the `videos` table.
- `next-frontend/` — out of scope for this phase (`desafio.md`: "Este é um desafio de backend … a interface de vídeo não faz parte do escopo desta fase"). No TD in this document; the upload handshake defined in TD-02 is the contract a future frontend phase will consume.

**Inherited constraints (not reopened):**

- Object storage is **S3-compatible, MinIO locally** (`docs/diagrams/software-arch.mermaid`, `CLAUDE.md` Architecture, `desafio.md` "Sobre o object storage"). TD-03 decides _how_ to use it, not _which_ storage.
- PostgreSQL 17 + TypeORM migrations, global JWT guard with `@Public()` opt-out, domain-exception filter, repository pattern and `*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts` test suffixes (Phases 01–02, `docs/decisions/technical-decisions-phase-01-configuracao-base.md`, `technical-decisions-phase-02-auth.md`).
- **Docker networking rule** (`CLAUDE.md`): service-to-service hosts are Compose service names, never `localhost`. TD-03 documents the single, deliberate exception (client-facing presigned URLs).
- A video belongs to a **channel** (`desafio.md` "Contexto"); every user has exactly one channel (Phase 02).

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the C4 diagram leave the queue as "TBD". The API must publish a "process this video" job after the upload finishes and the worker must consume it with retries, without the API waiting for FFmpeg. Installed stack: NestJS 11, TypeORM 0.3, PostgreSQL 17 (no Redis, no broker today). This is the main open stack decision of the phase.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq` + `bullmq`)
- Redis-backed job queue with first-class NestJS integration (`@Processor`, `WorkerHost`, `@InjectQueue`, `@OnWorkerEvent`). Retries with exponential backoff, deduplication by `jobId`, delayed jobs, stalled-job recovery and job events are built in.
- **Pros:** Official NestJS queue recipe; `attempts`/`backoff`/`removeOnComplete` are declarative; `jobId = videoId` gives idempotent publishing; the worker can be a plain Nest application context sharing the API's code; very small Compose footprint (one `redis` service).
- **Cons:** Adds Redis as a new stateful dependency; Redis must run with `maxmemory-policy noeviction` to avoid losing jobs; enqueue is not transactional with PostgreSQL (needs a compensation rule — see TD-08).

### Option B: RabbitMQ (`amqplib` / `@nestjs/microservices` RMQ transport)
- A real message broker with exchanges, queues, acks and dead-letter exchanges. Nest supports it through the microservices transport.
- **Pros:** Mature broker semantics (DLX, per-message TTL, routing), language-agnostic if the worker is ever rewritten.
- **Cons:** Heavier operationally (management plugin, definitions, DLX topology to hand-build); retry/backoff must be assembled manually with DLX + TTL queues; the Nest RMQ transport models request/response and events, not "jobs", so job-level state (attempts, backoff) is re-implemented by us.

### Option C: pg-boss (PostgreSQL as the queue)
- Queue persisted in the existing PostgreSQL using `SKIP LOCKED`. No new infrastructure; enqueue can share a transaction with the video update.
- **Pros:** Zero new containers; transactional enqueue (outbox for free); one backup/consistency story.
- **Cons:** No first-party Nest integration (custom provider/lifecycle wiring); workers poll the same database that serves the API; the desafio explicitly expects a queue service running alongside the stack ("fila … reais subindo no Compose"), which this option would not demonstrate as a distinct service.

### Option D: AWS SQS (ElasticMQ locally)
- Managed queue with an S3-style local emulator.
- **Pros:** Aligns with the S3 production story; zero broker operations in production.
- **Cons:** Local emulator is yet another image with partial SQS parity; visibility-timeout based retries (no native backoff); long-running jobs need visibility extension; no first-class Nest integration.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the officially documented NestJS job-queue path, covers retry/backoff/idempotency declaratively, and keeps the worker in the same TypeScript codebase. The only loss is non-transactional enqueue, which TD-08 handles with an explicit compensation rule; pg-boss would have won on transactionality but loses on Nest integration and on showing a real queue service in Compose.

**Decision:** A (BullMQ + Redis). Redis image `redis:7-alpine` started with `--maxmemory-policy noeviction`. Queue name `video-processing`, job name `process-video`, `jobId = <video uuid>`.
**Libraries:** @nestjs/bullmq, bullmq, ioredis, redis:7-alpine

**Revisions:**
- 2026-11-08 — Library pins verified against official docs/npm metadata: `@nestjs/bullmq` is pinned to `^11.0.5` (not 12.x) and `ioredis` (`^5.11.1`) is added as an explicit dependency. `@nestjs/bullmq@12.0.0` is ESM-only (`"type": "module"`) and fails to load under the project's CommonJS + Jest 30 setup (reproduced: "Must use import to load ES Module"); `bullmq@6.x` no longer bundles a Redis client (`ioredis`/`redis` are optional peers loaded lazily), so the backend must install `ioredis` itself. Rationale: Nest 11 compatibility and a working Jest suite; the "Redis client" noted by validation is `ioredis`.

---

## TD-02: Large-File Upload Strategy (10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The API must accept files up to 10GB "sem impacto na performance" and `desafio.md` forbids streaming the file through the API in a way that can lock the system. The strategy also defines when the draft video is pre-registered ("ao iniciar o upload"). `next-frontend/` is out of scope in this phase, so the handshake is defined only as an API contract that a future browser client can follow.

**Options:**

### Option A: `multipart/form-data` through the API (Multer / busboy streaming to S3)
- The client POSTs the whole file to the NestJS API, which streams it to storage.
- **Pros:** One endpoint; simplest client; API can validate bytes as they pass.
- **Cons:** Every byte crosses the API process and its network/CPU; long-lived connections hold sockets and event-loop time per upload; a failure at 9.9GB restarts from zero; contradicts the "sem segurar a API durante o envio" requirement.

### Option B: Direct-to-storage S3 multipart upload with presigned part URLs
- The API only coordinates: it pre-registers the draft, calls `CreateMultipartUpload`, hands out presigned `UploadPart` URLs (one per part), and later calls `CompleteMultipartUpload`. File bytes go client → MinIO/S3, never through the API.
- **Pros:** API cost per upload is O(parts) tiny JSON calls regardless of file size; parts upload in parallel and can be retried individually (resumable); S3 limits fit (5 MiB–5 GiB per part, ≤10 000 parts); identical API on MinIO and S3 so production swap is a configuration change.
- **Cons:** More moving parts (init → part URLs → complete); the client must read the `ETag` of each part (needs CORS `ExposeHeaders: ETag` on the bucket/server); abandoned multipart uploads need a cleanup policy; size is only enforceable on the declared value and re-checked on completion.

### Option C: tus resumable upload protocol (`@tus/server` embedded or `tusd`)
- Open resumable-upload protocol with its own server that forwards to S3.
- **Pros:** Standard resumable semantics and existing client libraries.
- **Cons:** Introduces a second server component (or a protocol implementation in the API) in front of storage; the bytes still traverse that server; adds a protocol to learn/test for a requirement that S3 multipart already satisfies natively.

**Recommendation:** **Option B (S3 multipart + presigned part URLs)** — it is the only option where the 10GB payload never touches the API, and S3-compatible MinIO is already mandated. The extra handshake complexity is contained in one service and fully testable against real MinIO.

**Decision:** B. Handshake: (1) authenticated `POST` creates the **draft** video and the multipart upload (pre-registration happens here, before any byte is sent) and returns `partSize` / `partCount`; (2) authenticated `POST` returns presigned part URLs for the requested part numbers; (3) client `PUT`s each part directly to storage and collects the `ETag`s; (4) authenticated `POST` completes the upload, which moves the video to `processing` and publishes the job (TD-08). Limits: maximum declared size **10 GiB** (`10 × 1024³` bytes), fixed `partSize` **64 MiB** (⇒ ≤ 160 parts for 10 GiB), presigned part URL TTL **1 hour**. The declared size is re-verified with `HeadObject` on completion; an oversize object is deleted and rejected.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-11-08 — Added abandoned-upload cleanup policy (validation MD-2): incomplete multipart uploads are expired by the storage server (MinIO `MINIO_API_STALE_UPLOADS_EXPIRY=24h`; on AWS S3 an `AbortIncompleteMultipartUpload` lifecycle rule is the equivalent and is an infrastructure task outside this phase). Orphan `draft` rows are kept (draft management belongs to Phase 04). Rationale: TD-02 listed abandoned multipart uploads as a con without resolving it.

---

## TD-03: Object Storage Organisation and Access

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage product is fixed (S3 API; MinIO in Docker). What remains open is the SDK, the bucket/key layout, how the API, worker and external clients reach it (presigned URLs embed the host, and the Docker rule forbids `localhost` between containers), and which MinIO image can actually be pulled today.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), one bucket, prefixed keys
- Official S3 SDK, modular v3 clients, `forcePathStyle: true` for MinIO. One bucket (`streamtube`), keys `videos/{publicId}/original.{ext}` and `videos/{publicId}/thumbnail.jpg`.
- **Pros:** Same code runs on MinIO and AWS S3; official support for multipart (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`) and presigning; per-video prefix keeps all artefacts of a video together (easy delete/lifecycle); one bucket = one CORS/policy surface.
- **Cons:** Slightly verbose API; two endpoints (internal vs client-facing) must be modelled explicitly.

### Option B: AWS SDK v3, two buckets (`videos`, `thumbnails`)
- Same SDK, separate buckets per artefact type.
- **Pros:** Per-type policies (e.g., public-read thumbnails later), independent lifecycle rules.
- **Cons:** Two buckets to provision/configure/CORS in every environment; no requirement in this phase needs different policies; keys of one video are split across buckets.

### Option C: `minio` JS client
- MinIO's own SDK.
- **Pros:** Compact API, built-in `presignedPutObject`.
- **Cons:** Ties code to a MinIO-flavoured client while production targets S3; weaker presigned-multipart support (part URLs need manual query-string assembly); less alignment with the stated "trocaria por S3 em produção".

**Recommendation:** **Option A** — the AWS SDK v3 is the portable, officially supported path for S3 + MinIO; a single bucket with per-video prefixes satisfies "vídeos e thumbnails" without extra provisioning. Rejected C because it undermines the S3 production swap.

**Decision:** A. Details:

- Keys are derived from the video `publicId` (TD-06): `videos/{publicId}/original.{ext}` and `videos/{publicId}/thumbnail.jpg`; the stored `storage_key` / `thumbnail_key` columns hold them.
- Two endpoints in configuration: `S3_ENDPOINT` (internal, Compose service name `http://minio:9000`, used for API/worker calls) and `S3_PUBLIC_ENDPOINT` (host embedded in presigned URLs, reachable by the client, `http://localhost:9000` in local dev). This is the only place where a client-facing `localhost` is allowed, because a presigned signature covers the host. Containers that must follow presigned URLs (tests) override `S3_PUBLIC_ENDPOINT` to `http://minio:9000`.
- The bucket is created idempotently at startup by the storage service (`HeadBucket` → `CreateBucket`).
- MinIO runs from `chainguard/minio:latest`: `minio/minio` is no longer pullable from Docker Hub and `quay.io/minio/minio` requires authentication (verified 2026-11-08), so the Chainguard-published image is the pullable one. CORS for browser `PUT` is enabled through `MINIO_API_CORS_ALLOW_ORIGIN` and `ETag` exposure.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, chainguard/minio

**Revisions:**
- 2026-11-08 — MinIO CORS claim corrected against the MinIO server source/docs: `ETag` is exposed to browsers by default (MinIO's CORS handler uses its common S3 header list, which includes `ETag`, for both allowed and exposed headers), so only `MINIO_API_CORS_ALLOW_ORIGIN` (comma-separated origins, default `*`) needs to be set; bucket-level `PutBucketCors` is a no-op on MinIO. On AWS S3 a bucket CORS rule with `ExposeHeaders: ETag` remains an infrastructure requirement. Rationale: the original text implied a separate ETag-exposure setting that MinIO does not have.
- 2026-11-08 — S3 client configuration pinned: `forcePathStyle: true` plus `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`; presigning must use a client whose `endpoint` is `S3_PUBLIC_ENDPOINT` (the signed host is the client's endpoint). With the SDK default (`WHEN_SUPPORTED`), a presigned `UploadPart` URL embeds `x-amz-checksum-crc32` (checksum of an empty body) and `x-amz-sdk-checksum-algorithm=CRC32` as query parameters (verified on `@aws-sdk/client-s3@3.1161.0`), which would not match the real part bytes; with `WHEN_REQUIRED` they are absent. Rationale: SDK v3 default checksum behaviour is incompatible with browser-uploaded presigned parts (server-side MinIO rejection not exercised here — to be confirmed by the real-infrastructure tests of TD-09).

---

## TD-04: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Architecture shows a separate "Video Worker (FFmpeg)" container that consumes queue jobs, reads/saves storage and updates the DB. It needs FFmpeg/ffprobe binaries and must not run inside the HTTP API process. The decision is how that worker is built, packaged and run.

**Options:**

### Option A: Same repository/package, second entrypoint as a Nest standalone application (`NestFactory.createApplicationContext`)
- `src/video-worker/` holds a `VideoWorkerModule` and `main.ts`. It reuses the `Video` entity, repositories, config and storage service. Compose runs it as a separate `video-worker` service from the same image as the API (FFmpeg installed in that image), with a different command.
- **Pros:** Shares entity/repository/config code with no duplication or publishing step; same TypeScript/ESLint/Jest tooling and migrations; true process/container isolation from the HTTP API; scaling = `docker compose up --scale video-worker=N`.
- **Cons:** API and worker images are the same (FFmpeg lands in the API image too); both must be kept compatible when the schema changes.

### Option B: Separate package/app in the monorepo (own `package.json`, own image)
- A `video-worker/` project that duplicates or imports shared code.
- **Pros:** Minimal worker image; independent dependency set.
- **Cons:** Needs shared-code publication or duplication of entity/config; second toolchain and lockfile; heavier for a phase that adds one consumer.

### Option C: Processor inside the API process (`@Processor` in `AppModule`)
- BullMQ worker runs in the same Node process as HTTP.
- **Pros:** Simplest deployment.
- **Cons:** FFmpeg/ffprobe child processes and CPU-heavy work compete with request handling; violates the architecture diagram (separate Video Worker container) and the "sem travar o sistema" goal.

**Recommendation:** **Option A** — container isolation without a second toolchain; the diagram's Video Worker is a separate container, and a Nest application context gives DI-based reuse of entities and services.

**Decision:** A. Worker entrypoint `src/video-worker/main.ts`, scripts `start:worker` / `start:worker:dev` (`nest start --entryFile video-worker/main`), Compose service `video-worker` (same Dockerfile as the API, FFmpeg installed there). The processor runs with concurrency `1` per container (FFmpeg is CPU-bound; scale by containers).
**Libraries:** @nestjs/bullmq

---

## TD-05: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** After upload the worker must extract duration and metadata and produce a thumbnail from a frame. Inputs can be up to 10GB, so copying the file to the worker's disk would be slow and need ≥10GB of scratch space per job.

**Options:**

### Option A: Native `ffprobe` / `ffmpeg` binaries via `child_process.execFile`, reading the object through a presigned GET URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` returns duration/size/codecs/resolution; `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 out.jpg` extracts one frame, then the worker uploads the JPEG. FFmpeg reads the object with HTTP range requests, so no full download.
- **Pros:** No wrapper dependency; no multi-GB local copy; arguments are an explicit array (no shell); failures map to exit codes/stderr we can classify.
- **Cons:** Containers/MP4 whose index sits at the end of the file cause extra range requests; we own the argument construction and output parsing.

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API over the same binaries.
- **Pros:** Convenient chaining API.
- **Cons:** The package is deprecated/archived; adds a stale dependency around two commands we can call directly.

### Option C: Download the object to a temp file, then run FFmpeg on the local file
- **Pros:** Local seeks are fastest for FFmpeg; simple error handling.
- **Cons:** Up to 10GB of scratch disk and transfer time per job; slower time-to-ready; needs cleanup on every failure path.

**Recommendation:** **Option A** — avoids staging 10GB locally and keeps the worker dependency-free; FFmpeg's HTTP input is the documented way to read remote media.

**Decision:** A. Thumbnail frame time = `min(10% of duration, 10s)`; when the duration is missing or ≤ 0 the frame at `0s` is used; output JPEG scaled to width 1280 (height auto, even). The metadata persisted: `duration_seconds`, and a `metadata` JSON (`container`, `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `size_bytes`). A file without a video stream is rejected as invalid media (non-retriable, TD-08). Presigned GET URLs for FFmpeg are signed against `S3_ENDPOINT` (the worker is inside the Docker network).
**Libraries:** ffmpeg

**Revisions:**
- 2026-11-08 — Thumbnail frame time rule made unambiguous (`min(10% of duration, 10s)`, `0s` fallback). Rationale: validation AMB-1 — the original `min(1s, duration/2)` / `otherwise 10%` rule had an unreachable branch and no missing-duration case.

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public, unique, URL-safe identifier that does not reveal sequence/volume and cannot collide. It is used in API paths (`/videos/:publicId`) and storage keys. Phase 04 will let users edit titles, so the identifier must not be derived from mutable data.

**Options:**

### Option A: Random 11-character base64url id (generated with `crypto.randomBytes`) + unique constraint
- 8 random bytes ⇒ 64 bits ⇒ 11 base64url characters (YouTube-style). Stored in a `public_id` column with a `UNIQUE` index; on the astronomically unlikely unique violation the insert retries with a new id.
- **Pros:** Short, URL-safe, unguessable, independent of title; collision handled both statistically and by the database constraint; no dependency.
- **Cons:** Not human-readable; needs a bounded retry loop on `23505`.

### Option B: UUID v4 as the public identifier
- Reuse the primary key in URLs.
- **Pros:** No new column; guaranteed format.
- **Cons:** 36-character URLs; exposes the primary key.

### Option C: Title-derived slug with numeric suffix
- **Pros:** Readable URLs.
- **Cons:** Title is mutable (Phase 04) so the URL breaks or must be redirected; collisions must be resolved with counters; leaks content in URLs.

**Recommendation:** **Option A** — short, opaque and decoupled from mutable data; the `UNIQUE` constraint is the real guarantee and mirrors the nickname collision-retry pattern already used in `ChannelsService`.

**Decision:** A. Column `public_id varchar(11) UNIQUE NOT NULL`; up to 5 retries on PostgreSQL unique violation `23505` over `public_id`. The primary key stays an internal `uuid`.

---

## TD-07: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file (HTTP range requests / `206 Partial Content`) and users must be able to download the original file. The C4 diagram draws `Frontend → Object Storage: Streams`. Authorisation (only `ready` videos are playable) must stay under API control.

**Options:**

### Option A: API endpoint that authorises and redirects (`302`) to a short-lived presigned GET URL
- `GET /videos/:publicId/stream` and `GET /videos/:publicId/download` check the video is `ready`, then redirect to a presigned URL (download adds `response-content-disposition=attachment`). Storage serves ranges natively (`Accept-Ranges`, `206`).
- **Pros:** Bytes never cross the API (consistent with TD-02); MinIO/S3 already implement correct range semantics; matches the C4 diagram (the client streams from storage); download filename/disposition handled by S3 response overrides.
- **Cons:** Presigned URLs are bearer links valid until TTL; the redirect target host must be client-reachable (`S3_PUBLIC_ENDPOINT`).

### Option B: API proxy that parses `Range` and pipes `GetObject` back (`206`)
- **Pros:** Full control of headers and future per-request authorisation; storage never exposed.
- **Cons:** Every streamed byte passes through Node (CPU/connection cost for large videos); we re-implement range parsing and edge cases (suffix ranges, 416).

### Option C: Public bucket / CDN in front of storage
- **Pros:** Offloads delivery entirely.
- **Cons:** Removes per-request authorisation and the `ready` gate; unlisted/visibility rules planned for Phase 04 would be unenforceable; no CDN exists in the stack.

**Recommendation:** **Option A** — keeps all bytes off the API, delegates range handling to a battle-tested implementation, and keeps the authorisation decision in the API.

**Decision:** A. Both endpoints are `@Public()` (anonymous users may watch/download; the video must be `ready`, otherwise `409`), respond `302` with a `Location` presigned against `S3_PUBLIC_ENDPOINT`, TTL **1 hour**. Visibility (public/unlisted) is explicitly Phase 04.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-08: Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Serviço de processamento em segundo plano (filas)

**Context:** The video moves through draft → processing → ready/error and the API/worker/queue are three independent actors. We must define the transitions, retry policy, what "error" means, and what happens when publishing the job fails (PostgreSQL and Redis are not transactional together). Depends on TD-01, TD-02, TD-05.

**Options:**

### Option A: Four-state lifecycle `draft → processing → ready | error`, BullMQ retries with final-failure handler, compensation on enqueue failure
- `draft`: pre-registered at upload start. `processing`: upload completed, job published. `ready`: worker persisted metadata+thumbnail. `error`: processing failed permanently, with `error_message`. BullMQ `attempts: 3`, exponential backoff (5 s base); non-retriable failures (no video stream / not a media file) fail immediately via `UnrecoverableError`; the worker's `failed` handler sets `error` only when no attempts remain. If publishing fails after the DB commit, the API marks the video `error` and answers `503`.
- **Pros:** Maps 1:1 to the status vocabulary of the desafio; every transition has exactly one owner; failure is visible in the database; processor is idempotent (only acts on `processing`).
- **Cons:** `error` is terminal in this phase (no re-processing endpoint); a crash between commit and enqueue is covered only by the compensation try/catch.

### Option B: Add an `uploading` state and a polling reconciler
- Extra state between draft and processing, plus a periodic job that re-enqueues stuck videos.
- **Pros:** Self-healing for lost jobs; finer visibility of in-flight uploads.
- **Cons:** More states than the desafio defines, a scheduler component and more tests; unjustified before a failure mode is observed.

### Option C: Transactional outbox in PostgreSQL feeding the queue
- **Pros:** Exactly-once-ish publish.
- **Cons:** A relay process and extra table for a single event type; disproportionate here.

**Recommendation:** **Option A** — smallest lifecycle that satisfies the stated statuses, with an explicit, testable failure path; B/C are deferrable hardening.

**Decision:** A. Allowed transitions: `draft → processing` (API, on upload completion); `processing → ready` and `processing → error` (worker); `processing → error` (API compensation when publishing the job fails); `draft → error` (API, when the completed object is unusable, i.e. larger than the 10 GiB limit). Any other transition is rejected. Only the owner channel may initiate/complete an upload.
**Libraries:** bullmq

**Revisions:**
- 2026-11-08 — Transition table and completion edge cases made explicit (validation IC-1). Completion order is: (1) `CompleteMultipartUpload`; (2) `HeadObject` size check; (3) transaction `draft → processing`; (4) publish job. A storage failure in step 1 (invalid parts/ETags, unknown upload) leaves the video in `draft` and returns an error so the client can retry; step 1 is retry-safe — if the multipart upload no longer exists but the object exists, processing continues from step 2. An oversize object (step 2) is deleted and the video goes `draft → error` (`FILE_TOO_LARGE`). A publish failure (step 4) is `processing → error` (`ENQUEUE_FAILED`) with HTTP `503`. Completing a video that is not in `draft` is rejected with `409`. Rationale: the original text listed `draft → error` with no trigger and left the failure statuses of completion undefined.
- 2026-11-08 — Failure-handler condition and size check made explicit (validation IC-2, AMB-3). The worker's `failed` handler sets `processing → error` when the error is a BullMQ `UnrecoverableError` **or** `job.attemptsMade >= job.opts.attempts`; otherwise the job is retried and the video stays `processing`. The completion size check compares the **actual** `HeadObject` `ContentLength` with the fixed cap only: `ContentLength > 10 GiB` → object deleted, video `draft → error` (`FILE_TOO_LARGE`), HTTP `413`; `ContentLength == 0` → same path with `EMPTY_FILE`, HTTP `422`. The client-declared `sizeBytes` is used only to plan the part count; the persisted `size_bytes` is the actual `ContentLength` (no mismatch rejection). Rationale: an invalid-media failure on attempt 1 would otherwise never meet the "no attempts remain" condition and leave the video stuck in `processing`; the oversize rule did not say which size it compared nor which HTTP status it returned.

---

## TD-09: Testing Against Real Infrastructure

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo; Reprodução via streaming (sem necessidade de download completo)

**Context:** `desafio.md`: "Não mocke o que dá para testar de verdade com a infra do Compose." Integration/e2e tests must exercise real MinIO, Redis, PostgreSQL and FFmpeg, yet stay fast and need no large binary fixtures in git.

**Options:**

### Option A: Compose services (MinIO, Redis) + FFmpeg in the test container + generated fixtures
- Tests run inside the `nestjs-api` container (Compose DNS names), FFmpeg is installed in that image, and tiny videos are generated at test time with `ffmpeg -f lavfi -i testsrc`. Unit tests (`*.spec.ts`) mock collaborators; integration/e2e tests use the real services, with per-suite unique keys/queue names for isolation.
- **Pros:** Real behaviour of multipart, presigning, range requests, queue retries and FFmpeg; no committed binaries; matches the existing integration pattern (real DB).
- **Cons:** Tests need the infra up; suite is slower than pure mocks.

### Option B: Testcontainers
- Tests start their own MinIO/Redis containers.
- **Pros:** Hermetic per run.
- **Cons:** Needs Docker-in-Docker from inside the `nestjs-api` container; duplicates the Compose services already required by the deliverable.

### Option C: Mocks/in-memory fakes (aws-sdk-client-mock, `ioredis-mock`)
- **Pros:** Fast, no infra.
- **Cons:** Does not verify presigned URLs, multipart, range or FFmpeg behaviour — exactly the risky parts — and conflicts with the desafio.

**Recommendation:** **Option A** — the deliverable already requires these services in Compose, so reusing them keeps tests honest and cheap to maintain.

**Decision:** A. Large-file behaviour is verified structurally (multi-part upload with several parts against real MinIO and part-count/limit math for 10 GiB) rather than by pushing 10GB through CI.

---

## TD-10: Draft Creation Payload and Media-Type Allow-list

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Download do vídeo pelo usuário

**Context:** Validation (MD-1) found that no decision defines what the client sends when it starts an upload, where the `{ext}` of the storage key comes from, or what filename a download gets. The draft must be created before the first byte is sent (TD-02), so these inputs must be validated up-front and must never be trusted to build storage keys. Phase 04 owns later title/description edits.

**Options:**

### Option A: Declared metadata + server-side allow-list mapping content type → extension
- Body: `filename` (display/original name), `contentType`, `sizeBytes`, optional `title`. `contentType` must be in an allow-list (`video/mp4`→`mp4`, `video/webm`→`webm`, `video/quicktime`→`mov`, `video/x-matroska`→`mkv`); the storage extension comes from that map, never from `filename`. `title` defaults to the filename without its extension, trimmed to 100 characters. The real file is still verified by ffprobe in the worker.
- **Pros:** Storage keys cannot be influenced by client-chosen strings; early, cheap rejection of non-video uploads; download filename is deterministic.
- **Cons:** New container formats need an allow-list change; declared type can lie (hence the worker re-check).

### Option B: Trust the filename extension
- **Pros:** Zero mapping code.
- **Cons:** Client-controlled input in object keys; any extension accepted; inconsistent with the actual content.

### Option C: Accept any `video/*` and sniff only in the worker
- **Pros:** Maximum flexibility.
- **Cons:** Non-video or exotic types are only rejected after a 10GB upload; extension still needs a source.

**Recommendation:** **Option A** — fail fast before a large upload and keep client strings out of storage keys, while the worker's ffprobe remains the content authority.

**Decision:** A. `sizeBytes` is an integer `1 … 10 GiB`; `title` max 100 chars (defaults to the filename stem); `filename` max 255 chars. The download response sets `Content-Disposition: attachment` with the filename `{title}.{ext}` sanitised to a filesystem-safe string (fallback: the stored original filename).

---

## TD-11: Phase 03 Read Surface (Status and Thumbnail Access)

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Validation (AMB-2) found that nothing says how the owner observes the status lifecycle (draft → processing → ready/error), the extracted duration/metadata or the generated thumbnail in this phase. Public video pages, listings and visibility (public/unlisted) belong to Phases 04–05 and are not part of this phase.

**Options:**

### Option A: One owner-only video resource endpoint
- `GET /videos/:publicId` (authenticated) returns the video the caller's channel owns, in any status: status, duration, metadata, error message and a presigned `thumbnailUrl` (TTL 1 hour) when available. Non-owners get `404` so the existence of a video is not leaked. Stream/download stay public (TD-07).
- **Pros:** Smallest surface that makes the lifecycle observable and testable; no visibility rules needed yet.
- **Cons:** No public video details yet (explicitly Phase 04/05).

### Option B: Public details endpoint with optional authentication
- **Pros:** One endpoint for owner and public.
- **Cons:** Requires a new optional-auth mechanism on a globally guarded API and visibility rules that belong to Phase 04.

### Option C: No read endpoint (observe through the database only)
- **Pros:** Zero code.
- **Cons:** Status/thumbnail cannot be exercised through the API; fails the "ciclo de status … refletido" check from the client side.

**Recommendation:** **Option A** — minimal, owner-scoped and forward-compatible with Phase 04's visibility work.

**Decision:** A. The thumbnail is returned as a presigned URL signed against `S3_PUBLIC_ENDPOINT` (same rule as TD-07); the draft listing/management panel is out of scope (Phase 04).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | Option A (BullMQ + Redis) | A |
| TD-02 | Backend | Large-File Upload Strategy (10GB) | Option B (S3 multipart + presigned part URLs) | B |
| TD-03 | Backend | Object Storage Organisation and Access | Option A (AWS SDK v3, one bucket, prefixed keys) | A |
| TD-04 | Backend | Video Worker Runtime Topology | Option A (same package, Nest standalone worker container) | A |
| TD-05 | Backend | Metadata Extraction and Thumbnail Generation | Option A (native ffprobe/ffmpeg on presigned URL) | A |
| TD-06 | Backend | Unique Video URL Identifier | Option A (11-char base64url + UNIQUE) | A |
| TD-07 | Backend | Streaming and Download Delivery | Option A (302 to presigned GET) | A |
| TD-08 | Backend | Status Lifecycle and Failure Handling | Option A (draft→processing→ready/error, retries, compensation) | A |
| TD-09 | Backend | Testing Against Real Infrastructure | Option A (Compose services + generated fixtures) | A |
| TD-10 | Backend | Draft Creation Payload and Media-Type Allow-list | Option A (declared metadata + server-side allow-list) | A |
| TD-11 | Backend | Phase 03 Read Surface (Status and Thumbnail Access) | Option A (owner-only `GET /videos/:publicId`) | A |
