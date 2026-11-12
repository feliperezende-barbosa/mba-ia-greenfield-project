---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
  bullmq:
    version: "^6.5.3"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
  ioredis:
    version: "^5.11.1"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
  "redis:7-alpine":
    version: "7-alpine (Docker image tag)"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1161.0"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1161.0"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
  "chainguard/minio":
    version: "latest (mutable Docker image tag)"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
  ffmpeg:
    version: "Debian apt package `ffmpeg` (7:5.1.x on the node:25.6.0-slim / bookworm base)"
    context7_id: "n/a — Context7 unavailable; official docs + npm metadata used"
    fetched_at: "2026-11-08T11:40:31-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T11:45:08-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice (`TD-01`, `TD-02`, `TD-03`, `TD-04`, `TD-05`, `TD-07`, `TD-08`).

**Provenance — Context7 was NOT available in this environment and was NOT used.** Every entry below was built from the real sources named in its `**Source:**` line: `npm view` / the published package contents (type declarations, `package.json`), small local experiments in a throw-away directory (deleted afterwards), official documentation pages, and the upstream MinIO source. Anything not verified is marked **Unverified**. Re-fetch when the underlying TD changes.

Installed stack: NestJS `^11.0.1`, TypeORM `^0.3.28`, Jest `^30`, `module: nodenext` with a CommonJS package (no `"type": "module"`), Docker base `node:25.6.0-slim` (its digest equals `node:25.6.0-bookworm-slim` ⇒ Debian 12).

## @nestjs/bullmq

**Source:** `npm view` + published tarball contents (11.0.5, 12.0.0) + <https://docs.nestjs.com/techniques/queues> (docs repo `content/application/queues.md`) — no Context7.

- **Pin `^11.0.5` (not 12.x).** `npm view @nestjs/bullmq` → latest `12.0.0`, peers `@nestjs/core|common ^10 || ^11 || ^12`, `bullmq ^3 … ^6`, so it is *declared* compatible with Nest 11. **But 12.0.0 is ESM-only** (`"type": "module"`, `.js`-suffixed re-exports in `dist/index.js`); `11.0.5` is CommonJS (peers `^10 || ^11`, `bullmq ^3 … ^6`). Reproduced in a scratch project with Jest 30: `require('@nestjs/bullmq')` fails for 12.0.0 (`Must use import to load ES Module`) and passes for 11.0.5. The current Nest docs on `master` describe the 12.x line (e.g. `import.meta.dirname`); the module/decorator API shown below is the same in 11.0.5 (types checked).
- Install: `npm i @nestjs/bullmq@^11.0.5 bullmq@^6.5.3 ioredis@^5.11.1`.
- Root module: `BullModule.forRoot({ connection: { host, port } })` (also `forRootAsync({ imports, useFactory, inject })` to read `ConfigService`); options besides `extraOptions` go straight to the BullMQ `Queue` constructor (`connection`, `prefix` default `bull`, `defaultJobOptions`).
- Queue: `BullModule.registerQueue({ name: 'video-processing' })`; producer injects with `@InjectQueue('video-processing') queue: Queue` (`Queue` from `bullmq`) and calls `queue.add('process-video', data, opts)`.
- Consumer: class decorated `@Processor('video-processing')` **extending `WorkerHost`**, implementing `process(job: Job): Promise<any>`; must be a registered provider. BullMQ has no per-job-name handler decorator — switch on `job.name` inside `process()`.
- Worker options: `@Processor(queueName, workerOptions)` overload exists in 11.0.5 (`NestWorkerOptions`), e.g. `{ concurrency: 1 }` (`WorkerOptions.concurrency` verified in `bullmq` types) — matches TD-04.
- Events: `@OnWorkerEvent('failed')` inside the `@Processor` class (`@OnWorkerEvent(eventName: keyof WorkerListener)`); queue-level `@QueueEventsListener` + `@OnQueueEvent` is optional.
- Standalone worker (TD-04): the docs do not describe `NestFactory.createApplicationContext` specifically; the processor is registered on `onModuleInit`, so a Nest application context that imports the module starts consuming. **Unverified** end-to-end here; covered by TD-09 integration tests.

## bullmq

**Source:** `npm view bullmq@6.5.3`, published package (`package.json`, `dist/esm/**/*.d.ts`, `redis-connection.js`), <https://docs.bullmq.io/guide/connections>, <https://docs.bullmq.io/guide/going-to-production>, <https://docs.bullmq.io/guide/retrying-failing-jobs> — no Context7.

- Version `6.5.3` (npm latest; engines `node >=14.18.0` ⇒ fine on Node 25). Dependencies are `msgpackr`, `cron-parser`, `semver`, `node-abort-controller`, `tslib` — **no Redis client**: `ioredis`, `redis`, `pg`, `bullmq-otel` are *optional peers*; the default driver is loaded lazily and throws `BullMQ could not load the optional 'ioredis' package` when absent ⇒ install `ioredis` (see below).
- `JobsOptions` (verified in `base-job-options.d.ts`): `attempts?: number`, `backoff?: number | { type: 'fixed' | 'exponential' | string; delay?: number; jitter?: number }`, `removeOnComplete` / `removeOnFail?: boolean | number | KeepJobs`, `jobId?: string`.
- Retries (docs): exponential backoff retries after `2 ^ (attemptsMade - 1) * delay` ms; `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }` ⇒ waits ≈ 5 s then 10 s — matches TD-08. `defaultJobOptions` on the queue applies the same to every job.
- Non-retriable failures: `import { UnrecoverableError } from 'bullmq'` (`new UnrecoverableError(message)`) — "moves a job to failed even if the attemptsMade are lower than the expected limit" (type docs) — matches TD-08.
- `failed` worker event signature (verified): `(job: Job | undefined, error: Error, prev: string) => void`; **it fires on every failed attempt**, so the handler must check `job.attemptsMade >= job.opts.attempts` (both exist on `Job`) before marking the video `error`, as TD-08 already states. `job` can be `undefined` (guard it). Verified in `job.js`/`worker.js` (6.5.3): `moveToFailed` increments `attemptsMade` **before** the worker emits `failed`, so inside the handler `attemptsMade` already counts the failed attempt (with `attempts: 3`: `1`, `2` ⇒ retried, `3` ⇒ final) and `attemptsMade >= opts.attempts` is the correct "no attempts remain" test; the job is retried iff `attemptsMade + 1 < opts.attempts` **and** the error is not an `UnrecoverableError` (`instanceof` or `err.name === 'UnrecoverableError'`), so an `UnrecoverableError` on attempt 1 yields `failed` with `attemptsMade = 1 < 3` — the handler must test the error type too (TD-08 revision `UnrecoverableError || attemptsMade >= attempts`). `job.opts.attempts` defaults to `0` when unset (always `>=`), so set `attempts` on every job (or via `defaultJobOptions`).
- `jobId` idempotency: custom ids must be strings, **cannot be integer-like and cannot contain `:`** (checked in `job.js`) — a UUID is fine. Adding a job whose id already exists is **silently ignored** (type docs); a retained completed/failed job with the same id therefore also blocks re-adding — keep that in mind with `removeOnComplete`/`removeOnFail` (TD-08 has no re-processing endpoint, so this is acceptable).
- Production notes (docs): Redis **must** run with `maxmemory-policy noeviction` ("the only setting that guarantees correct behaviour") — confirms TD-01; the docs also recommend AOF persistence (`appendonly yes`, ~1 s fsync) — not in TD-01, consider it for the Compose Redis volume. Worker connections default to `maxRetriesPerRequest: null`; Queue (producer) calls should fail fast when Redis is down.
- Connection: `connection: { host: 'redis', port: 6379 }` — host is the Compose service name (Docker networking rule).

## ioredis

**Source:** `npm view ioredis` / `bullmq@6.5.3` `package.json` (peer `ioredis >=5.0.0`, optional; dev-dependency `5.11.1`); smoke test with `ioredis@5.11.1` — no Context7.

- Added to TD-01's Libraries because `bullmq@6` does not bundle a Redis client. npm `latest` is `6.0.0`, but BullMQ 6.5.3 is developed/tested against `5.11.1`; pin `^5.11.1` (engines `node >=12.22.0`). Whether `ioredis@6` also works with BullMQ 6.5.3 (peer range allows it) was **not** tested here.
- Not used directly in application code: BullMQ creates the connections from the `connection` options passed to `BullModule.forRoot`.

## redis:7-alpine

**Source:** Docker Hub API (`library/redis` tag `7-alpine`: multi-arch incl. amd64/arm64, last updated 2026-11-06) + BullMQ "Going to production" docs — no Context7.

- Run as `redis-server --maxmemory-policy noeviction` (TD-01) — required by BullMQ. Recommended addition from the BullMQ docs: `--appendonly yes` with a named volume so queued jobs survive restarts.
- Healthcheck / CLI usage (`redis-cli ping`) not re-verified here.

## @aws-sdk/client-s3

**Source:** `npm view` + published package (`dist-types`) for `3.1161.0` + a local presigning experiment (no network, no MinIO) — AWS SDK v3 API reference not fetched separately — no Context7.

- Version `3.1161.0` (latest), engines `node >=20.0.0`. Keep `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` on the same version.
- Commands used by the phase, all exported and verified by import: `CreateMultipartUploadCommand`, `UploadPartCommand` (part numbers `1 … 10,000` per the command docs), `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `HeadObjectCommand`, `HeadBucketCommand`, `CreateBucketCommand`, `GetObjectCommand`, `DeleteObjectCommand`.
- Client for MinIO: `new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`. Two clients are needed: one with `endpoint = S3_ENDPOINT` (internal calls, worker presigned URLs) and one with `endpoint = S3_PUBLIC_ENDPOINT` for URLs handed to browsers (the signed host is the client's endpoint — confirmed: the generated URL starts with the configured endpoint).
- **Checksum gotcha (verified by generating URLs, MinIO behaviour NOT tested):** with the default config a presigned `UploadPart` URL contains `x-amz-checksum-crc32=AAAAAA%3D%3D&x-amz-sdk-checksum-algorithm=CRC32` (CRC32 of an *empty* body). Setting `requestChecksumCalculation: 'WHEN_REQUIRED'` (and `responseChecksumValidation: 'WHEN_REQUIRED'`, which also drops `x-amz-checksum-mode=ENABLED` from GET URLs) removes them. Recorded as a Revision on TD-03; confirm against real MinIO in the TD-09 integration tests.
- `GetObjectCommandInput.ResponseContentDisposition?: string` exists (verified in `models_0.d.ts`); a presigned GET then carries `response-content-disposition=attachment%3B%20filename%3D%22…%22` — used by TD-07/TD-10 downloads.
- Client-side concerns from TD-02: S3 limits (5 MiB–5 GiB per part, ≤ 10,000 parts) match the 64 MiB / ≤ 160-part plan (limit values come from the AWS API docs shipped with the types for the part number; the 5 MiB/5 GiB bounds were **not** re-verified here).

## @aws-sdk/s3-request-presigner

**Source:** `npm view` + published package for `3.1161.0` + local experiment — no Context7.

- `import { getSignedUrl } from '@aws-sdk/s3-request-presigner'; await getSignedUrl(client, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 })` — verified to produce a URL with `X-Amz-Expires=3600`, `partNumber`, `uploadId`, `X-Amz-SignedHeaders=host` and `UNSIGNED-PAYLOAD`. `GetObjectCommand` URLs work the same way (`expiresIn` seconds).
- The part `PUT` from the browser must send the raw part bytes only (no extra signed headers) and read the `ETag` response header (see MinIO CORS below).

## chainguard/minio

**Source:** Docker Hub API (`chainguard/minio` exists: tags `latest`, `latest-dev`, amd64 + arm64, updated 2026-11-08; `minio/minio` returns "object not found") + MinIO server source on GitHub (`internal/config/api/api.go`, `cmd/api-router.go`, `cmd/erasure-multipart.go`) + `docs.min.io` (community docs now redirect to AIStor docs, whose settings page does not list these variables) — no Context7.

- Image `chainguard/minio:latest` is pullable (matches TD-03); `latest` is a mutable tag. **Unverified (needs a pull, out of scope here):** entrypoint / default command (`server /data --console-address ":9001"`), root credential env vars, whether the image has a shell/`curl`/`mc` for healthchecks (Chainguard images are typically minimal — prefer a healthcheck that needs no extra tooling or verify `latest-dev`).
- The upstream `minio/minio` repository is archived ("no longer maintained", points to AIStor) — the behaviour below is read from its `master` source, which is what community builds are based on.
- **Stale multipart cleanup (TD-02 Revision — claim confirmed):** env `MINIO_API_STALE_UPLOADS_EXPIRY` (config key `api stale_uploads_expiry`), **default `24h`**, Go duration syntax; `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL`, **default `6h`**. Incomplete uploads older than the expiry are removed by a cleanup that runs every interval ⇒ effective abort 24–30 h after the upload was *initiated* (in-progress uploads included). Setting `24h` explicitly is therefore redundant but harmless and self-documenting.
- **CORS (TD-03 Revision — claim corrected):** env `MINIO_API_CORS_ALLOW_ORIGIN`, **default `*`**, comma-separated list matched with wildcards (an empty entry is an error). MinIO's CORS handler allows `GET, PUT, HEAD, POST, DELETE, OPTIONS, PATCH` and uses the same common S3 header list for both `AllowedHeaders` and `ExposedHeaders`, and that list includes `ETag` ⇒ **no separate ETag-exposure setting is needed on MinIO**. Bucket-level `PutBucketCors`/`GetBucketCors` are dummy handlers on MinIO. On AWS S3 a bucket CORS rule with `ExposeHeaders: ["ETag"]` is still required.
- Presigned URL host must be reachable by the client: `S3_PUBLIC_ENDPOINT=http://localhost:9000` is an allowed exception to the Docker `localhost` rule (see TD-03).

## ffmpeg

**Source:** <https://ffmpeg.org/ffprobe.html>, <https://ffmpeg.org/ffmpeg.html>, <https://ffmpeg.org/ffmpeg-protocols.html> (current docs, not version-specific), Debian sources API (`sources.debian.org/api/src/ffmpeg`) for package versions, Docker Hub digests for the base image — no Context7.

- Installed with `apt-get install -y --no-install-recommends ffmpeg` in the shared API/worker image; the package ships both `ffmpeg` and `ffprobe`. Base `node:25.6.0-slim` is Debian 12 (bookworm) ⇒ apt provides `7:5.1.x` (bookworm: `5.1.9-0+deb12u1`; trixie would be `7.1.5`). No wrapper library; call binaries with `child_process.execFile` (argument array, no shell) — per TD-05 (`fluent-ffmpeg` rejected).
- `ffprobe` options confirmed in the docs: `-show_format`, `-show_streams`, `-print_format writer_name` (JSON writer: `-print_format json`). `-v error` is a standard logging option (`-v loglevel`) — not re-verified in the fetched text.
- `ffmpeg`: `-ss position` is an *input* option when placed before `-i` (seeks to the closest seek point); `-frames[:stream_specifier] framecount` is documented (`-frames:v 1` ⇒ one video frame); `-vframes` is documented as an obsolete alias. The scale filter expression `scale=1280:-2` was **not** re-verified from the docs fetched.
- HTTP input: the `http` protocol has a `seekable` option (default `-1` = autodetect from the server response) and `multiple_requests`; MinIO/S3 presigned GET URLs support `Range`, so seeking/`moov`-at-end inputs work through range requests (as TD-05 notes). **Unverified** here: behaviour of every real input against MinIO — covered by TD-09 integration tests with generated fixtures (`-f lavfi -i testsrc`).
- Timeouts for hung HTTP reads (`-rw_timeout`/`-timeout`) are not covered by the pages fetched — **Unverified**; consider `execFile`'s own `timeout` option when implementing.
