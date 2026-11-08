# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/13 completed

### SI-03.1 — Infra: ffmpeg, MinIO, Redis, dependências, configuração e suporte de testes
- **Status:** completed
- **Tests:** 18/18 passing (env.validation.integration-spec.ts, storage.config.spec.ts, queue.config.spec.ts); `test/app.e2e-spec.ts` still passing
- **Observations:**
  - `npm install` inside the container fails (ECONNRESET); dependencies installed on the host with `--os=linux --cpu=arm64 --libc=glibc --ignore-scripts` and verified with `require()` inside the container (`@nestjs/bullmq` resolves to 11.0.5).
  - `chainguard/minio:latest` confirmed: entrypoint `/usr/bin/minio`, so Compose sets `command: server /data --console-address ":9001"`; image has `bash` (used by the healthcheck). The healthcheck performs a real `GET /minio/health/live` over `/dev/tcp` with a `Host` header (without `Host` MinIO answers `400`) and checks for `200`; service turns `healthy` and `curl http://localhost:9000/minio/health/live` returns `200`.
  - `.env` is git-ignored: the new variables were added to it by hand (`MAIL_FROM` stays removed). `MINIO_API_CORS_ALLOW_ORIGIN` defaults to `*` in Compose (not in `.env.example`).
  - `redis` runs exactly as the plan states (`--maxmemory-policy noeviction`); `--appendonly yes` suggested by `library-refs.md` was not added (not in the plan).
  - `src/test/auth-test-helpers.ts` exports `registerConfirmAndLogin(app, dataSource, { email?, password? })` returning `{ access_token, user_id, email }` (plan only says it returns the `access_token`; extra fields are useful for ownership tests).
  - Config keys exposed by the namespaces: `storage` → `endpoint, publicEndpoint, region, bucket, accessKeyId, secretAccessKey`; `queue` → `host, port, prefix`.
  - The plan's `Test Specs: _pending_` markers exist only on SIs outside this batch (SI-03.5+); the Test Specs preflight was therefore not blocking for SI-03.1–03.4.

### SI-03.2 — Entidade Video, migration, repositório e identificador público
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.3 — StorageModule e StorageService (S3/MinIO)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.4 — QueueModule e produtor do job de processamento
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.5 — Pré-cadastro do vídeo como rascunho (POST /videos)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.6 — URLs pré-assinadas de partes (POST /videos/:publicId/upload/part-urls)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.7 — Conclusão do upload e publicação do job (POST /videos/:publicId/upload/completion)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.8 — MediaModule: metadados com ffprobe e thumbnail com ffmpeg
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.9 — Video worker: processor BullMQ, idempotência e tratamento de falha
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.10 — Leitura do vídeo pelo dono (GET /videos/:publicId)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.11 — Streaming e download (GET /videos/:publicId/stream e /download)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.12 — Pipeline ponta a ponta: upload, worker, streaming e download (E2E)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.13 — Contrato OpenAPI, exemplos `api.http` e documentação
- **Status:** pending
- **Tests:** pending
- **Observations:** none
