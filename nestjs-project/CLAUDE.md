# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl http://localhost:9000/minio/health/live` — expect HTTP `200` (the `minio` service also has a Compose healthcheck: `docker compose ps` shows `healthy`)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Rebuild the image after changing Dockerfile.dev (it installs ffmpeg/ffprobe, required by the worker and the media tests)
docker compose build

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — S3-compatible object storage (`chainguard/minio`), API on port `9000`, web console on `9001` (credentials = `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`); data in the `minio-data` volume; the `streamtube` bucket is created on startup by `StorageService`
- `redis` — Redis 7 (`--maxmemory-policy noeviction`), port `6379`; backs the BullMQ queue
- `video-worker` — consumer of the video-processing queue (same image and mounted source as `nestjs-api`, started with `npm run start:worker:dev`); starts with `docker compose up -d` and restarts unless stopped

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis and MinIO are ready
docker compose exec redis redis-cli ping
curl http://localhost:9000/minio/health/live

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs -f video-worker       # expect "Video worker started, waiting for jobs"

# Video worker lifecycle
docker compose up -d video-worker
docker compose up -d --scale video-worker=2 video-worker   # more consumers (each processes one job at a time)

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run build:worker                     # Compile only the video worker to dist-worker/
npm run start:worker                     # Run the video worker (queue consumer, no HTTP server)
npm run start:worker:dev                 # Same, watch mode (what the video-worker Compose service runs)
npm run openapi:export                   # Regenerate openapi.json (the contract consumed by the frontend)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules (and real MinIO / Redis / ffmpeg when the code under test uses them) | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db`, `minio` or `redis` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `setupFiles` also loads `src/test/test-env.ts`, which overrides `S3_PUBLIC_ENDPOINT` to `http://minio:9000` when `NODE_ENV=test` (see "Videos" → "Testing with real infrastructure").
- `test/jest-e2e.json` sets `maxWorkers: 1`: e2e suites share the database and must run serially.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Output

`nest build` compiles the API into `dist/` (`deleteOutDir: true` wipes it on every build). The video worker has its own tsconfig, `tsconfig.worker.json` (`outDir: dist-worker`, entry `src/video-worker/main.ts`), used by `build:worker`, `start:worker` and `start:worker:dev`. Keep the two outputs separate: the API dev server and the always-running `video-worker` container share the mounted source directory, and a single `dist/` would let one build delete the other's files. Both folders are git-ignored and excluded from `tsc --noEmit` and `nest build`.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos

Phase 03 (upload, background processing, streaming). Everything lives in `nestjs-project/src` with one module per responsibility:

| Path | Responsibility |
|------|----------------|
| `src/videos/` | `VideosModule`: `VideosController`, `VideosService`, `VideosRepository`, `Video` entity, DTOs, pure utils (`public-id.util`, `upload-plan.util`, `video-keys.util`, `video-title.util`, `download-filename.util`), `video-status.enum`, `videos.constants` |
| `src/storage/` | `StorageModule` / `StorageService`: S3/MinIO access (AWS SDK v3) — multipart upload, presigned part and `GET` URLs, `headObject`, `putObject`, `deleteObject`; creates the bucket on startup |
| `src/queue/` | `QueueModule`: BullMQ connection on Redis, the `video-processing` queue and `VideoProcessingProducer` |
| `src/media/` | `MediaModule` / `MediaService`: `probe` (ffprobe) and `generateThumbnail` (ffmpeg) over a presigned URL |
| `src/video-worker/` | `VideoWorkerModule` (standalone Nest context, entry `main.ts`): `VideoProcessingProcessor` (BullMQ `WorkerHost`, `concurrency: 1`) and `VideoProcessingService` |
| `src/config/` | `storage.config.ts`, `queue.config.ts` (+ entries in `env.validation.ts`) |
| `src/test/` | Test support for the above (see "Testing with real infrastructure") |

### Endpoints

All under `/videos` (OpenAPI in `openapi.json`, examples in `api.http`, section "VÍDEOS"):

| Endpoint | Auth | Result |
|----------|------|--------|
| `POST /videos` | JWT | `201` draft in the caller's channel + `{ publicId, status, title, partSize, partCount }` |
| `POST /videos/:publicId/upload/part-urls` | JWT, owner | `200` presigned `UploadPart` URLs for the requested part numbers |
| `POST /videos/:publicId/upload/completion` | JWT, owner | `202` `{ publicId, status: "processing" }`; publishes the processing job |
| `GET /videos/:publicId` | JWT, owner | `200` status, duration, metadata, `errorMessage`, presigned `thumbnailUrl` |
| `GET /videos/:publicId/stream` | `@Public()` | `302` to a presigned `GET` URL (1 h); only `ready` |
| `GET /videos/:publicId/download` | `@Public()` | `302` to a presigned `GET` URL with `Content-Disposition: attachment`; only `ready` |

Owner-only routes answer the same `404 VIDEO_NOT_FOUND` for an unknown video and for another channel's video. `stream`/`download` answer `409 VIDEO_NOT_READY` for `draft`, `processing` and `error`. `publicId` is an 11-character base64url id (`public-id.util.ts`); the internal uuid never leaves the API. Error codes live in `src/common/exceptions/domain.exception.ts`.

### Status lifecycle

`draft → processing → ready | error`. Transitions are compare-and-set updates (`VideosRepository.transition(id, from, to)`), so repeated or concurrent calls cannot move a video twice. `error` is terminal; `videos.error_message` holds `"<CODE>: <detail>"` (`FILE_TOO_LARGE`, `EMPTY_FILE`, `ENQUEUE_FAILED` set by the API; `INVALID_MEDIA`, `PROCESSING_FAILED` set by the worker).

### Upload handshake (bytes never cross the API)

1. `POST /videos` with `filename`, `contentType` (allow-list in `videos.constants.ts`: mp4, webm, quicktime, x-matroska), `sizeBytes` (1 … 10 GiB), optional `title`. The API creates the draft, starts the S3 multipart upload and returns `partSize` (64 MiB, `UPLOAD_PART_SIZE_BYTES`) and `partCount` (max 160).
2. `POST …/upload/part-urls` with `partNumbers` (each ≤ `partCount`) → presigned URLs signed against `S3_PUBLIC_ENDPOINT`.
3. The client `PUT`s each part's raw bytes to its URL and keeps the **`ETag` response header** of every `PUT`.
4. `POST …/upload/completion` with `parts: [{ partNumber, etag }]`. The API completes the multipart upload, checks the real object size with `HeadObject` (0 bytes → `EMPTY_FILE`; > 10 GiB → `FILE_TOO_LARGE`), moves the video to `processing` and publishes the job.
5. The client polls `GET /videos/:publicId` until `ready` or `error`.

Storage keys: `videos/{publicId}/original.{ext}` (extension from the content-type allow-list, never from the file name) and `videos/{publicId}/thumbnail.jpg`.

### Queue and worker

- Queue `video-processing`, job `process-video`, payload `{ videoId, publicId }`, `jobId` = video uuid (idempotent publish), 3 attempts with exponential backoff (5 s base). Constants: `src/queue/video-processing.constants.ts`.
- The processor acts only on videos in `processing` (any other status is a no-op), so at-least-once delivery is safe. It runs ffprobe on a presigned internal URL, generates the JPEG thumbnail, and sets `ready` + `duration_seconds` + `metadata` + `thumbnail_key`. A file ffprobe cannot read fails once (`UnrecoverableError`) as `INVALID_MEDIA`; other failures are retried and end as `PROCESSING_FAILED`.
- A publish failure after the `draft → processing` commit marks the video `error` (`ENQUEUE_FAILED`, `503`).

### Environment variables

Declared in `.env.example` and validated in `src/config/env.validation.ts` (`.env` is git-ignored):

| Variable | Purpose |
|----------|---------|
| `S3_ENDPOINT` | MinIO address for container-to-container traffic (`http://minio:9000`) |
| `S3_PUBLIC_ENDPOINT` | Host embedded in presigned URLs handed to clients (`http://localhost:9000`) — the only documented `localhost` exception to the Docker-host rule (root `CLAUDE.md` → "Docker Networking") |
| `S3_REGION`, `S3_BUCKET` | Region (`us-east-1`) and bucket (`streamtube`) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credentials used by the API and the worker (required) |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO root credentials read by the `minio` Compose service; keep them equal to the two S3 credentials above |
| `MINIO_API_CORS_ALLOW_ORIGIN` | Optional (Compose default `*`): lets a browser `PUT` parts and read `ETag` |
| `REDIS_HOST`, `REDIS_PORT` | Redis address (`redis`, `6379`) |
| `QUEUE_PREFIX` | BullMQ key prefix (`bull`); tests use a unique one |

### Testing with real infrastructure

Video tests run against the real Compose services (no mocks of MinIO, Redis or ffmpeg at the integration/e2e layers):

- **`S3_PUBLIC_ENDPOINT` override:** Jest runs inside the Compose network, so `src/test/test-env.ts` sets `S3_PUBLIC_ENDPOINT=http://minio:9000` when `NODE_ENV=test`; presigned URLs can then be fetched from the test process (`fetch(url, { headers: { Range: 'bytes=0-99' } })`).
- **Unique `QUEUE_PREFIX` per suite:** set `process.env.QUEUE_PREFIX = 'test-<suite>-' + randomUUID()` before compiling the module, `queue.obliterate({ force: true })` in `beforeEach`/`afterAll`, and restore the original value in `afterAll`. This keeps tests away from the live `video-worker` (which consumes the default `bull` prefix) and from each other.
- **Worker in the test process:** `startTestWorker(queuePrefix)` (`src/test/worker-test-helpers.ts`) boots `VideoWorkerModule`; `waitForVideoStatus(dataSource, publicId, status, timeoutMs)` polls the database with an explicit timeout (generic `waitFor` in `src/test/wait-for.ts`). Start the worker only after asserting the `processing` state.
- **Media fixtures are generated, never committed:** `createMediaFixtures()` / `removeMediaFixtures()` (`src/test/media-fixtures.ts`) build tiny MP4s, an audio-only file, a text file and an ≥ 11 MiB noise clip with `ffmpeg` (lavfi sources) in a temp directory.
- **Storage helpers:** `putPartsViaPresignedUrls`, `deleteKeys` (`src/test/storage-test-helpers.ts`); delete the keys a test created in `afterAll`. Data builders: `src/test/video-test-data.ts`; auth: `src/test/auth-test-helpers.ts`.
- **Throttler:** the global `ThrottlerGuard` (10 req/min per IP) also covers `/videos*`; e2e tests clear `ThrottlerStorage` (`throttlerStorage.storage.clear()`) before each call or flow step.
- **Pipeline e2e:** `test/video-pipeline.e2e-spec.ts` covers upload → worker → `ready` → stream `Range`/`206` → download. The upload plan is fixed at 64 MiB parts, so multi-part tests declare `sizeBytes = (N - 1) × 64 MiB + 1` to get an N-part plan and upload smaller real parts (≥ 5 MiB except the last).
