---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-08T11:14:40-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T11:45:08-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-08T11:46:49-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-08T11:14:40-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-08T11:14:40-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-08T11:14:40-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-08T11:14:40-03:00"
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

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — video module, video worker (queue consumer + FFmpeg), new Compose services (object storage, queue, worker) and the `videos` table (source: `docs/decisions/technical-decisions-phase-03-videos.md` → Subprojects in scope; `docs/project-plan.md` does not list subprojects for this phase)

**Deferred subprojects:** `next-frontend` — video interface is not part of this phase (source: `desafio.md`; `docs/decisions/technical-decisions-phase-03-videos.md` → Subprojects in scope). The upload handshake of TD-02 is the contract a future frontend phase will consume.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública — Depende de: Fase 02, Fase 03.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Processing Queue Technology | decided | A (BullMQ + Redis) | `@nestjs/bullmq`, `bullmq`, `ioredis`, `redis:7-alpine` |
|     └─ Last revision: 2026-11-08 — Library pins verified against official docs/npm metadata: `@nestjs/bullmq`… | | | | | | |
| phase-03-videos/TD-02 | phase | Backend | Large-File Upload Strategy (10GB) | decided | B (S3 multipart + presigned part URLs) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
|     └─ Last revision: 2026-11-08 — Added abandoned-upload cleanup policy (validation MD-2): incomplete… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Organisation and Access | decided | A (AWS SDK v3, one bucket, prefixed keys) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `chainguard/minio` |
|     └─ Last revision: 2026-11-08 — S3 client configuration pinned: `forcePathStyle: true` plus… | | | | | | |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Runtime Topology | decided | A (same package, Nest standalone worker container) | `@nestjs/bullmq` |
| phase-03-videos/TD-05 | phase | Backend | Metadata Extraction and Thumbnail Generation | decided | A (native ffprobe/ffmpeg on presigned URL) | `ffmpeg` |
|     └─ Last revision: 2026-11-08 — Thumbnail frame time rule made unambiguous (`min(10% of duration, 10s)`,… | | | | | | |
| phase-03-videos/TD-06 | phase | Backend | Unique Video URL Identifier | decided | A (11-char base64url + UNIQUE) | — |
| phase-03-videos/TD-07 | phase | Backend | Streaming and Download Delivery | decided | A (302 to presigned GET) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| phase-03-videos/TD-08 | phase | Backend | Status Lifecycle and Failure Handling | decided | A (draft→processing→ready/error, retries, compensation) | `bullmq` |
|     └─ Last revision: 2026-11-08 — Failure-handler condition and size check made explicit (validation IC-2, AMB-3). | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Testing Against Real Infrastructure | decided | A (Compose services + generated fixtures) | — |
| phase-03-videos/TD-10 | phase | Backend | Draft Creation Payload and Media-Type Allow-list | decided | A (declared metadata + server-side allow-list) | — |
| phase-03-videos/TD-11 | phase | Backend | Phase 03 Read Surface (Status and Thumbnail Access) | decided | A (owner-only `GET /videos/:publicId`) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-09 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-08, phase-03-videos/TD-09 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-08, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-11 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-10 |

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader)_

### phase-03-videos/TD-01

**Recommendation:** it is the officially documented NestJS job-queue path, covers retry/backoff/idempotency declaratively, and keeps the worker in the same TypeScript codebase. The only loss is non-transactional enqueue, which TD-08 handles with an explicit compensation rule; pg-boss would have won on transactionality but loses on Nest integration and on showing a real queue service in Compose.
**Libraries:** `@nestjs/bullmq`, `bullmq`, `ioredis`, `redis:7-alpine`

**Revisions:**
- 2026-11-08 — Library pins verified against official docs/npm metadata: `@nestjs/bullmq` is pinned to `^11.0.5` (not 12.x) and `ioredis` (`^5.11.1`) is added as an explicit dependency. `@nestjs/bullmq@12.0.0` is ESM-only (`"type": "module"`) and fails to load under the project's CommonJS + Jest 30 setup (reproduced: "Must use import to load ES Module"); `bullmq@6.x` no longer bundles a Redis client (`ioredis`/`redis` are optional peers loaded lazily), so the backend must install `ioredis` itself. Rationale: Nest 11 compatibility and a working Jest suite; the "Redis client" noted by validation is `ioredis`.

### phase-03-videos/TD-02

**Recommendation:** it is the only option where the 10GB payload never touches the API, and S3-compatible MinIO is already mandated. The extra handshake complexity is contained in one service and fully testable against real MinIO.
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

**Revisions:**
- 2026-11-08 — Added abandoned-upload cleanup policy (validation MD-2): incomplete multipart uploads are expired by the storage server (MinIO `MINIO_API_STALE_UPLOADS_EXPIRY=24h`; on AWS S3 an `AbortIncompleteMultipartUpload` lifecycle rule is the equivalent and is an infrastructure task outside this phase). Orphan `draft` rows are kept (draft management belongs to Phase 04). Rationale: TD-02 listed abandoned multipart uploads as a con without resolving it.

### phase-03-videos/TD-03

**Recommendation:** the AWS SDK v3 is the portable, officially supported path for S3 + MinIO; a single bucket with per-video prefixes satisfies "vídeos e thumbnails" without extra provisioning. Rejected C because it undermines the S3 production swap.
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `chainguard/minio`

**Revisions:**
- 2026-11-08 — MinIO CORS claim corrected against the MinIO server source/docs: `ETag` is exposed to browsers by default (MinIO's CORS handler uses its common S3 header list, which includes `ETag`, for both allowed and exposed headers), so only `MINIO_API_CORS_ALLOW_ORIGIN` (comma-separated origins, default `*`) needs to be set; bucket-level `PutBucketCors` is a no-op on MinIO. On AWS S3 a bucket CORS rule with `ExposeHeaders: ETag` remains an infrastructure requirement. Rationale: the original text implied a separate ETag-exposure setting that MinIO does not have.
- 2026-11-08 — S3 client configuration pinned: `forcePathStyle: true` plus `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`; presigning must use a client whose `endpoint` is `S3_PUBLIC_ENDPOINT` (the signed host is the client's endpoint). With the SDK default (`WHEN_SUPPORTED`), a presigned `UploadPart` URL embeds `x-amz-checksum-crc32` (checksum of an empty body) and `x-amz-sdk-checksum-algorithm=CRC32` as query parameters (verified on `@aws-sdk/client-s3@3.1161.0`), which would not match the real part bytes; with `WHEN_REQUIRED` they are absent. Rationale: SDK v3 default checksum behaviour is incompatible with browser-uploaded presigned parts (server-side MinIO rejection not exercised here — to be confirmed by the real-infrastructure tests of TD-09).

### phase-03-videos/TD-04

**Recommendation:** container isolation without a second toolchain; the diagram's Video Worker is a separate container, and a Nest application context gives DI-based reuse of entities and services.
**Libraries:** `@nestjs/bullmq`

### phase-03-videos/TD-05

**Recommendation:** avoids staging 10GB locally and keeps the worker dependency-free; FFmpeg's HTTP input is the documented way to read remote media.
**Libraries:** `ffmpeg`

**Revisions:**
- 2026-11-08 — Thumbnail frame time rule made unambiguous (`min(10% of duration, 10s)`, `0s` fallback). Rationale: validation AMB-1 — the original `min(1s, duration/2)` / `otherwise 10%` rule had an unreachable branch and no missing-duration case.

### phase-03-videos/TD-06

**Recommendation:** short, opaque and decoupled from mutable data; the `UNIQUE` constraint is the real guarantee and mirrors the nickname collision-retry pattern already used in `ChannelsService`.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** keeps all bytes off the API, delegates range handling to a battle-tested implementation, and keeps the authorisation decision in the API.
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-08

**Recommendation:** smallest lifecycle that satisfies the stated statuses, with an explicit, testable failure path; B/C are deferrable hardening.
**Libraries:** `bullmq`

**Revisions:**
- 2026-11-08 — Transition table and completion edge cases made explicit (validation IC-1). Completion order is: (1) `CompleteMultipartUpload`; (2) `HeadObject` size check; (3) transaction `draft → processing`; (4) publish job. A storage failure in step 1 (invalid parts/ETags, unknown upload) leaves the video in `draft` and returns an error so the client can retry; step 1 is retry-safe — if the multipart upload no longer exists but the object exists, processing continues from step 2. An oversize object (step 2) is deleted and the video goes `draft → error` (`FILE_TOO_LARGE`). A publish failure (step 4) is `processing → error` (`ENQUEUE_FAILED`) with HTTP `503`. Completing a video that is not in `draft` is rejected with `409`. Rationale: the original text listed `draft → error` with no trigger and left the failure statuses of completion undefined.
- 2026-11-08 — Failure-handler condition and size check made explicit (validation IC-2, AMB-3). The worker's `failed` handler sets `processing → error` when the error is a BullMQ `UnrecoverableError` **or** `job.attemptsMade >= job.opts.attempts`; otherwise the job is retried and the video stays `processing`. The completion size check compares the **actual** `HeadObject` `ContentLength` with the fixed cap only: `ContentLength > 10 GiB` → object deleted, video `draft → error` (`FILE_TOO_LARGE`), HTTP `413`; `ContentLength == 0` → same path with `EMPTY_FILE`, HTTP `422`. The client-declared `sizeBytes` is used only to plan the part count; the persisted `size_bytes` is the actual `ContentLength` (no mismatch rejection). Rationale: an invalid-media failure on attempt 1 would otherwise never meet the "no attempts remain" condition and leave the video stuck in `processing`; the oversize rule did not say which size it compared nor which HTTP status it returned.

### phase-03-videos/TD-09

**Recommendation:** the deliverable already requires these services in Compose, so reusing them keeps tests honest and cheap to maintain.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** fail fast before a large upload and keep client strings out of storage keys, while the worker's ffprobe remains the content authority.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** minimal, owner-scoped and forward-compatible with Phase 04's visibility work.
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — from phases-reader, dedupe applied)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

## Inherited Conventions

_(from phases-reader — compact list; sourced from prior phases' `## Inherited Conventions`; the prior phases' own docs carry no `## Conventions to Match` section)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — Feature Implementation Checklist; per-artifact recipes in the skill's `artifacts/`, external-system strategies for storage/queue in `references/external-systems.md`)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

_Deferred subproject — out of scope for this phase (`desafio.md`); no testing requirements._
