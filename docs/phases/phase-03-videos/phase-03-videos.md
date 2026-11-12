---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T11:46:56-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-08T11:46:49-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T11:45:08-03:00"
  docs/project-plan.md: "2026-11-08T11:14:40-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-08T11:14:40-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-08T11:14:40-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-08T11:14:40-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-08T11:14:40-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o backend de ingestão de vídeos — serviço de armazenamento (MinIO/S3) e de filas (BullMQ + Redis), upload direto ao storage de até 10GB com pré-cadastro do vídeo como rascunho, worker de processamento (ffprobe + thumbnail via FFmpeg), URL pública única por vídeo e entrega por streaming e download via redirecionamento para URLs pré-assinadas.

---

## Step Implementations

### SI-03.1 — Infra: ffmpeg, MinIO, Redis, dependências, configuração e suporte de testes

**Description:** Prepara o ambiente da fase — ffmpeg na imagem, serviços `minio` e `redis` no Compose, dependências, namespaces de configuração `storage`/`queue` com validação Joi e suporte de testes — base das capacidades «Serviço de armazenamento de arquivos (vídeos e thumbnails)» e «Serviço de processamento em segundo plano (filas)».

**Technical actions:**

1. Atualizar `Dockerfile.dev` — instalar `ffmpeg` com `apt install -y --no-install-recommends` (fornece `ffmpeg` e `ffprobe`; per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`) e reconstruir a imagem (`docker compose build nestjs-api`)
2. Adicionar a `compose.yaml` o serviço `minio` (`chainguard/minio:latest`, volume nomeado `minio-data`, portas `9000` API S3 e `9001` console, `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, `MINIO_API_CORS_ALLOW_ORIGIN`, `MINIO_API_STALE_UPLOADS_EXPIRY=24h`, healthcheck via `bash` + `/dev/tcp`; per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`) e o serviço `redis` (`redis:7-alpine`, `redis-server --maxmemory-policy noeviction`, healthcheck `redis-cli ping`; per `phase-03-videos/TD-01`); `nestjs-api` passa a depender de ambos com `condition: service_healthy`. O entrypoint/command e a presença de `bash` na imagem `chainguard/minio` estão marcados como **Unverified** em `library-refs.md` — confirmar `server /data --console-address ":9001"` ao subir o serviço
3. Instalar em `nestjs-project`: `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0`, `@nestjs/bullmq@^11.0.5` (não 12.x — ESM-only), `bullmq@^6.5.3`, `ioredis@^5.11.1` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
4. Criar `src/config/storage.config.ts` (`registerAs('storage', ...)`: `S3_ENDPOINT` default `http://minio:9000`, `S3_PUBLIC_ENDPOINT` default `http://localhost:9000`, `S3_REGION` default `us-east-1`, `S3_BUCKET` default `streamtube`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) e `src/config/queue.config.ts` (`registerAs('queue', ...)`: `REDIS_HOST` default `redis`, `REDIS_PORT` default `6379`, `QUEUE_PREFIX` default `bull`); estender `src/config/env.validation.ts` (credenciais S3 obrigatórias, endpoints como URI, demais com default), registrar ambos em `ConfigModule.forRoot({ load })` de `AppModule` e atualizar `.env.example` (incl. `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`; hosts sempre com nome de serviço Compose — `S3_PUBLIC_ENDPOINT=http://localhost:9000` é a única exceção, per `phase-03-videos/TD-03`)
5. Criar o suporte de testes: `src/test/test-env.ts` (com `NODE_ENV === 'test'`, define `process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000'` para o container de teste seguir URLs pré-assinadas; per `phase-03-videos/TD-03`), registrá-lo em `setupFiles` após `dotenv/config` em `package.json` (`<rootDir>/test/test-env.ts`) e em `test/jest-e2e.json` (`<rootDir>/../src/test/test-env.ts`), e `src/test/auth-test-helpers.ts` (cria usuário via `POST /auth/register`, marca `is_confirmed = true` no banco e faz login, devolvendo o `access_token`) para os E2E das SIs seguintes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Unit: credenciais S3 obrigatórias, defaults e URIs inválidas rejeitadas | `src/config/env.validation.integration-spec.ts` (estender; `requiredEnv` passa a incluir as credenciais S3) |
| `storageConfig` | Unit: mapeamento env → config e defaults | `src/config/storage.config.spec.ts` |
| `queueConfig` | Unit: mapeamento env → config, coerção numérica de `REDIS_PORT` e defaults | `src/config/queue.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d minio redis` deixa ambos os serviços `healthy` em `docker compose ps`
- `curl http://localhost:9000/minio/health/live` (host) retorna `200`
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` terminam com código `0`
- Iniciar a aplicação sem `S3_ACCESS_KEY_ID` ou `S3_SECRET_ACCESS_KEY` falha na validação Joi no bootstrap — a aplicação não sobe
- Com os valores de `.env.example`, `GET /` continua retornando `200` (o E2E existente `test/app.e2e-spec.ts` passa)
- `docker compose exec nestjs-api node -e "require('@nestjs/bullmq')"` termina com código `0` e `npm ls @nestjs/bullmq` reporta a linha `11.x`
- No processo Jest (`NODE_ENV=test`), `process.env.S3_PUBLIC_ENDPOINT` vale `http://minio:9000` independentemente do `.env`

---

### SI-03.2 — Entidade Video, migration, repositório e identificador público

**Description:** Cria a entidade `Video` (status `draft | processing | ready | error`), a migration, o `VideosRepository` com transições condicionais e a geração de `public_id` único com retry — cobre «URL única por vídeo, sem conflito com outros vídeos» e a base de «Pré-cadastro automático do vídeo como rascunho ao iniciar o upload».

**Technical actions:**

1. Criar `src/videos/video-status.enum.ts` (`VideoStatus`: `draft`, `processing`, `ready`, `error`) e `src/videos/videos.constants.ts` (named exports `as const`: `MAX_VIDEO_SIZE_BYTES` = `10 * 1024 ** 3`, `UPLOAD_PART_SIZE_BYTES` = `64 * 1024 ** 2`, `MAX_UPLOAD_PARTS` = `160`, `PRESIGNED_URL_TTL_SECONDS` = `3600`, `VIDEO_CONTENT_TYPE_EXTENSIONS` (allow-list `contentType` → extensão), `PUBLIC_ID_BYTES` = `8`, `PUBLIC_ID_MAX_RETRIES` = `5`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`, `phase-03-videos/TD-10`)
2. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas do Data Model (snake_case; enum PostgreSQL `video_status`; `size_bytes` bigint com transformer string → number; `metadata` jsonb; `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })`) e adicionar `@OneToMany(() => Video, (video) => video.channel)` em `Channel` (ambos os lados, per `nestjs-entities.md`); incluir `Video` nos arrays de entidades dos `createTestDataSource([...])` existentes que listam `Channel` (o lado inverso exige o metadata de `Video`)
3. Gerar a migration via CLI (`npm run migration:generate -- src/database/migrations/CreateVideos`) e revisar o SQL: tabela `videos`, enum `video_status`, índice único em `public_id`, FK `channel_id → channels`, índice em `channel_id`, `down` reversível (per `typeorm-migrations.md`)
4. Criar `src/videos/public-id.util.ts` (`generatePublicId()`: `randomBytes(8).toString('base64url')` → 11 caracteres) e `src/videos/video-keys.util.ts` (`buildOriginalKey(publicId, ext)` → `videos/{publicId}/original.{ext}`; `buildThumbnailKey(publicId)` → `videos/{publicId}/thumbnail.jpg`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`)
5. Criar `src/videos/videos.repository.ts` (`VideosRepository`: `createDraft(input)` — insert avulso (sem transação, logo sem savepoint) com `public_id` gerado e `storage_key` derivado, até 5 retries em violação `23505` sobre `public_id`; `findByPublicId`; `findOwnedByPublicId(publicId, channelId)`; `setUploadId`; `transition(id, from, to, patch, manager?)` — `UPDATE … WHERE id = :id AND status = :from` que retorna se afetou uma linha (per `phase-03-videos/TD-08`); `deleteById`), `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, exporta `VideosRepository`) e adicionar `DELETE FROM "videos"` antes de `channels` em `cleanAllTables` (`src/test/create-test-data-source.ts`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unicidade de `public_id`, FK `channel_id`, default `status = draft`, enum rejeita valor inválido, colunas anuláveis, round-trip de `metadata` jsonb, `size_bytes` lido como number | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: 11 caracteres, alfabeto base64url, sem colisões em amostra grande | `src/videos/public-id.util.spec.ts` |
| `buildOriginalKey` / `buildThumbnailKey` | Unit: layout das chaves a partir de `publicId` + extensão | `src/videos/video-keys.util.spec.ts` |
| `VideosRepository` | Integration: `createDraft` repete em colisão de `public_id` (spy no gerador) e propaga após 5 retries; `transition` é no-op fora do estado `from`; `findOwnedByPublicId` escopa por canal | `src/videos/videos.repository.integration-spec.ts` |
| Migration `CreateVideos` | Integration: aplicar/reverter cria/remove `videos` e o enum | `src/database/migrations.integration-spec.ts` (estender) |

**Dependencies:** SI-03.1 — ambiente Compose e suporte de testes (`setupFiles`)

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com as colunas do Data Model, o enum `video_status`, índice único em `public_id` e FK `channel_id → channels`; `npm run migration:revert` remove a tabela e o enum
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade
- Inserir um vídeo com `channel_id` inexistente falha com violação de chave estrangeira
- Um vídeo recém-criado tem `status = 'draft'`; inserir `status` fora do enum falha
- `VideosRepository.createDraft` persiste `public_id` com 11 caracteres `[A-Za-z0-9_-]` e `storage_key = videos/{public_id}/original.{ext}`
- Após colisão de `public_id`, `createDraft` gera outro identificador (até 5 retries) e propaga a violação de unicidade quando os retries se esgotam
- `transition(id, 'draft', 'processing', …)` sobre um vídeo `ready` não altera a linha e retorna `false`
- As suites existentes que listam `Channel` continuam passando após a inclusão de `Video` nos `DataSource` de teste

---

### SI-03.3 — StorageModule e StorageService (S3/MinIO)

**Description:** Implementa o serviço de armazenamento sobre o AWS SDK v3 — bucket garantido no startup, multipart upload com URLs pré-assinadas, HEAD/DELETE/PUT e GETs pré-assinados nos endpoints interno e público — cobre «Serviço de armazenamento de arquivos (vídeos e thumbnails)».

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` (tokens `S3_INTERNAL_CLIENT` e `S3_PUBLIC_CLIENT`) e `src/storage/storage.module.ts` — providers que criam dois `S3Client` a partir de `ConfigType<typeof storageConfig>` com `region`, `credentials`, `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'`: um com `endpoint = S3_ENDPOINT` (chamadas da API/worker e URLs lidas pelo ffmpeg) e outro com `endpoint = S3_PUBLIC_ENDPOINT` (URLs entregues ao cliente, pois o host assinado é o do client); exporta `StorageService` (per `phase-03-videos/TD-03`)
2. Criar `src/storage/storage.service.ts` — `onModuleInit` garante o bucket (`HeadBucket` → `CreateBucket` apenas quando o bucket não existe; qualquer outro erro propaga)
3. Em `StorageService`, operações de multipart (per `phase-03-videos/TD-02`): `createMultipartUpload(key, contentType): Promise<string>` (retorna o `UploadId`), `presignUploadPartUrls(key, uploadId, partNumbers)` (client público, TTL 3600 s) e `completeMultipartUpload(key, uploadId, parts)` — os erros S3 `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` e `NoSuchUpload` viram `InvalidMultipartUploadError` (`src/storage/storage.errors.ts`, com `reason` = nome do erro S3); demais erros propagam
4. Em `StorageService`, operações de objeto: `headObject(key)` → `{ contentLength } | null` (objeto inexistente → `null`), `deleteObject(key)`, `putObject(key, body, contentType)`, `presignPublicGetUrl(key, { expiresIn, responseContentDisposition? })` (client público) e `presignInternalGetUrl(key, expiresIn)` (client interno, usado por ffprobe/ffmpeg) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
5. Criar `src/test/storage-test-helpers.ts` — `uniqueTestPublicId()` (chaves únicas por teste/suite, per `phase-03-videos/TD-09`), `deleteKeys(storage, keys)` para limpeza em `afterAll` e `putPartsViaPresignedUrls(...)` (envia partes por `fetch` `PUT` nas URLs pré-assinadas e coleta os `ETag`) reutilizados pelas SIs seguintes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real do Compose): bucket garantido de forma idempotente; multipart com 3 partes (2 × 5 MiB + resto) enviado por URLs pré-assinadas com `ETag` legível, `completeMultipartUpload` e `headObject` com o tamanho total; `ETag` inválido → `InvalidMultipartUploadError`; `headObject` de chave inexistente → `null`; `putObject` + GET pré-assinado público com `Range` → `206`; `responseContentDisposition` refletido no header; URLs de parte sem `x-amz-checksum-*`; host das URLs = endpoint configurado | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Unit: `ensureBucket` só cria o bucket quando ele não existe e propaga outros erros; mapeamento dos erros de completion (client S3 mockado) | `src/storage/storage.service.spec.ts` |
| `StorageModule` | Unit: compilação com `storageConfig` real; dois clients com endpoints distintos | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — serviço `minio`, dependências AWS SDK e `storageConfig`

**Acceptance criteria:**

- Ao iniciar a aplicação, o bucket `streamtube` existe no MinIO; iniciá-la novamente não falha (criação idempotente)
- Um multipart upload de 3 partes (2 × 5 MiB + resto) por URLs pré-assinadas termina em um objeto cujo tamanho no storage é a soma dos bytes enviados
- A URL pré-assinada de parte não contém `x-amz-checksum-crc32` nem `x-amz-sdk-checksum-algorithm`, o `PUT` de bytes reais é aceito pelo MinIO e o response traz o header `ETag`
- `completeMultipartUpload` com `ETag` inválido rejeita com `InvalidMultipartUploadError` e nenhum objeto é criado
- `headObject` de uma chave inexistente retorna `null`
- GET pré-assinado público com `Range: bytes=0-99` retorna `206` com 100 bytes; com `responseContentDisposition` o response traz `Content-Disposition: attachment; filename="…"`
- URLs públicas começam com `S3_PUBLIC_ENDPOINT` e URLs internas com `S3_ENDPOINT`

---

### SI-03.4 — QueueModule e produtor do job de processamento

**Description:** Configura o BullMQ sobre o Redis do Compose — fila `video-processing`, job `process-video`, tentativas com backoff exponencial — e o produtor idempotente (`jobId` = uuid do vídeo) — cobre «Serviço de processamento em segundo plano (filas)».

**Technical actions:**

1. Criar `src/queue/video-processing.constants.ts` (`VIDEO_PROCESSING_QUEUE` = `'video-processing'`, `PROCESS_VIDEO_JOB` = `'process-video'`, `PROCESS_VIDEO_ATTEMPTS` = `3`, `PROCESS_VIDEO_BACKOFF_DELAY_MS` = `5000`) e `src/queue/video-processing.types.ts` (`ProcessVideoJobData`: `{ videoId: string; publicId: string }`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` (`connection: { host, port }` e `prefix` vindos de `queueConfig.KEY`) e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 } })`; exporta `BullModule` (o worker registra o `@Processor` na mesma fila) e `VideoProcessingProducer`
3. Criar `src/queue/video-processing.producer.ts` — `VideoProcessingProducer.enqueue({ id, public_id })` chama `queue.add(PROCESS_VIDEO_JOB, { videoId, publicId }, { jobId: id })` via `@InjectQueue`; falha do Redis propaga (a compensação pertence à `VideosService`, SI-03.7); `add` de um `jobId` já existente é ignorado silenciosamente pelo BullMQ (idempotência)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Unit: `queue.add` chamado com nome, payload e `jobId`; rejeição propaga (Queue mockada) | `src/queue/video-processing.producer.spec.ts` |
| `VideoProcessingProducer` | Integration (Redis real, `QUEUE_PREFIX` único por suite): job em `waiting` com nome, payload, `jobId` e opções; publicar duas vezes mantém um job | `src/queue/video-processing.producer.integration-spec.ts` |
| `QueueModule` | Integration: compila contra o Redis do Compose; fila resolvível pelo token, `prefix` e `defaultJobOptions` aplicados | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.1 — serviço `redis`, dependências BullMQ e `queueConfig`

**Acceptance criteria:**

- Publicar o job de um vídeo cria na fila `video-processing` um job `process-video` com id igual ao uuid do vídeo e dados `{ videoId, publicId }`, em estado `waiting`
- O job criado tem `attempts = 3` e backoff exponencial com `delay = 5000`
- Publicar o mesmo vídeo duas vezes mantém um único job na fila
- Com o Redis inacessível a publicação rejeita com erro (nenhuma falha silenciosa)
- Suites com `QUEUE_PREFIX` distintos não enxergam jobs umas das outras

---

### SI-03.5 — Pré-cadastro do vídeo como rascunho (POST /videos)

**Description:** Endpoint autenticado que valida a declaração do arquivo, cria o `Video` em `draft` no canal do usuário e inicia o multipart upload no storage, devolvendo `publicId`, `partSize` e `partCount` — cobre «Pré-cadastro automático do vídeo como rascunho ao iniciar o upload», «URL única por vídeo, sem conflito com outros vídeos» e o início do «Upload de vídeos com suporte a arquivos de até 10GB».
**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Autenticado (JWT) — o rascunho é criado no canal do próprio usuário

**Technical actions:**

1. Criar os DTOs `src/videos/dto/create-video.dto.ts` (`filename`, `contentType` com `@IsIn` na allow-list, `sizeBytes` com `@IsInt @Min(1) @Max(MAX_VIDEO_SIZE_BYTES)`, `title?` com `@IsOptional @IsString @MinLength(1) @MaxLength(100)`) e `src/videos/dto/create-video-response.dto.ts` (`@ApiProperty` em todos os campos, per `nestjs-dtos.md`) (per `phase-03-videos/TD-10`, `### API Contracts` → POST /videos)
2. Criar `src/videos/upload-plan.util.ts` (`planUploadParts(sizeBytes)` → `{ partSize: 64 MiB, partCount: ceil(sizeBytes / partSize) }`, no máximo 160 para 10 GiB) e `src/videos/video-title.util.ts` (`deriveTitle(filename)`: nome sem a última extensão, `trim`, truncado em 100 caracteres; sem stem, usa o nome completo truncado) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-10`)
3. Adicionar `ChannelsService.getByUserId(userId)` (lança `ChannelNotFoundException`) e a exceção `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404) em `src/common/exceptions/domain.exception.ts` (per `### Error Catalog`)
4. Criar `VideosService.createDraft(userId, dto)` — resolve o canal, planeja as partes, `videosRepository.createDraft` (título default via `deriveTitle`), `storage.createMultipartUpload(storage_key, contentType)` e `setUploadId`; se o storage falhar, remove o rascunho recém-criado e relança o erro (compensação, sem engolir); retorna `{ publicId, status, title, partSize, partCount }` (per `phase-03-videos/TD-02` passo 1)
5. Criar `src/videos/videos.controller.ts` (`@ApiTags('videos')`, `@Controller('videos')`, `POST /` com `@HttpCode(201)`, `@ApiBearerAuth('access-token')` e `@ApiOperation`/`@ApiResponse` para 201, 400, 401 e 404 com `ApiErrorEnvelope`, per `nestjs-controllers.md`); declarar controller/`VideosService` e importar `ChannelsModule` e `StorageModule` em `VideosModule`; importar `VideosModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: título default, plano de partes, compensação quando o storage falha, canal ausente (repo/storage/channels mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration (DB + MinIO reais): linha `draft` com `upload_id`, `storage_key` e `part_count`; o multipart upload existe no storage | `src/videos/videos.service.integration-spec.ts` |
| `planUploadParts` | Unit: limites (1 byte → 1 parte; 64 MiB → 1; 64 MiB + 1 → 2; 10 GiB → 160) | `src/videos/upload-plan.util.spec.ts` |
| `deriveTitle` | Unit: extensão removida, `trim`, truncamento em 100, nome sem stem | `src/videos/video-title.util.spec.ts` |
| `ChannelsService.getByUserId` | Integration: retorna o canal do usuário; usuário sem canal → `ChannelNotFoundException` | `src/channels/channels.service.integration-spec.ts` (estender) |

**Dependencies:** SI-03.2 — entidade/repositório; SI-03.3 — storage; SI-03.1 — helpers de autenticação para os E2E

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", contentType: "video/mp4", sizeBytes: 157286400 }` e token válido retorna `201` com `publicId` de 11 caracteres, `status: "draft"`, `title: "aula"`, `partSize: 67108864` e `partCount: 3`
- O vídeo criado existe no banco em `draft`, ligado ao canal do usuário autenticado, com `storage_key = videos/{publicId}/original.mp4` e `upload_id` preenchido
- `POST /videos` com `title` informado persiste o título informado; sem `title`, o título é o nome do arquivo sem extensão, truncado em 100 caracteres
- `POST /videos` com `contentType: "application/pdf"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `sizeBytes: 0` ou `sizeBytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- Falha do storage ao criar o multipart upload resulta em erro (não `201`) e nenhuma linha órfã do vídeo permanece
- Dois `POST /videos` consecutivos retornam `publicId` distintos

---

### SI-03.6 — URLs pré-assinadas de partes (POST /videos/:publicId/upload/part-urls)

**Description:** Endpoint do dono do vídeo que devolve URLs pré-assinadas de `UploadPart` para as partes solicitadas, para que o cliente envie os bytes diretamente ao storage sem passar pela API — cobre «Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance».
**Route:** POST /videos/:publicId/upload/part-urls
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Dono do vídeo (JWT); não-dono recebe `404`

**Technical actions:**

1. Criar os DTOs `src/videos/dto/part-urls-request.dto.ts` (`partNumbers` com `@IsArray @ArrayMinSize(1) @ArrayMaxSize(160) @ArrayUnique @IsInt({ each: true }) @Min(1, { each: true })`) e `src/videos/dto/part-urls-response.dto.ts` (`expiresInSeconds`, `urls[]` com `@ApiProperty`) (per `### API Contracts` → POST /videos/:publicId/upload/part-urls)
2. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoNotInDraftException` (`VIDEO_NOT_IN_DRAFT`, 409) e `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400) (per `### Error Catalog`)
3. Criar `VideosService.getPartUrls(userId, publicId, dto)` — resolve o canal do usuário, `findOwnedByPublicId` (inexistente ou de outro canal → `VideoNotFoundException`), exige status `draft`, valida `partNumber <= part_count` e chama `storage.presignUploadPartUrls`; retorna `{ expiresInSeconds: 3600, urls }` (per `phase-03-videos/TD-02` passo 2)
4. Adicionar a rota `POST :publicId/upload/part-urls` em `VideosController` (`@HttpCode(200)`, `@ApiBearerAuth('access-token')`, `@ApiResponse` para 200, 400, 401, 404 e 409 com `ApiErrorEnvelope`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPartUrls` | Unit: não-dono → `VideoNotFoundException`, vídeo fora de `draft` → `VideoNotInDraftException`, `partNumber` acima de `part_count` → `InvalidPartNumberException` | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.getPartUrls` | Integration (DB + MinIO reais): as URLs retornadas aceitam `PUT` de bytes reais e devolvem `ETag` | `src/videos/videos.service.integration-spec.ts` (estender) |

**Dependencies:** SI-03.5 — rascunho, `VideosService` e `VideosController`

**Acceptance criteria:**

- `POST /videos/:publicId/upload/part-urls` com `{ partNumbers: [1, 2] }` do dono retorna `200` com `expiresInSeconds: 3600` e duas URLs cujo host é o de `S3_PUBLIC_ENDPOINT`
- Um `PUT` de bytes na URL de uma parte retornada é aceito pelo storage e o response traz o header `ETag`
- `partNumbers` com número maior que o `partCount` do vídeo retorna `400` com `error: "INVALID_PART_NUMBER"`
- `partNumbers` vazio, com duplicados ou contendo `0` retorna `400` com `error: "VALIDATION_ERROR"`
- `publicId` inexistente e `publicId` de vídeo de outro canal retornam a mesma resposta `404` com `error: "VIDEO_NOT_FOUND"`
- Vídeo fora de `draft` retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"`
- Requisição sem token retorna `401`

---

### SI-03.7 — Conclusão do upload e publicação do job (POST /videos/:publicId/upload/completion)

**Description:** Endpoint do dono que completa o multipart upload, confere o tamanho real do objeto, move o vídeo para `processing` e publica o job de processamento, respondendo `202`, com as falhas e compensações do ciclo de status — cobre «Upload de vídeos com suporte a arquivos de até 10GB», «Serviço de processamento em segundo plano (filas)» e o início de «Processamento automático do vídeo após upload».
**Route:** POST /videos/:publicId/upload/completion
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Dono do vídeo (JWT); não-dono recebe `404`

**Technical actions:**

1. Criar os DTOs `src/videos/dto/complete-upload.dto.ts` (`parts[]` de `{ partNumber, etag }` com `@ValidateNested({ each: true })`, `@Type`, `@ArrayMinSize(1)`, `@ArrayMaxSize(160)` e `partNumber` único) e `src/videos/dto/complete-upload-response.dto.ts` (`publicId`, `status`)
2. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções `UploadCompletionFailedException` (`UPLOAD_COMPLETION_FAILED`, 422), `FileTooLargeException` (`FILE_TOO_LARGE`, 413), `EmptyFileException` (`EMPTY_FILE`, 422) e `EnqueueFailedException` (`ENQUEUE_FAILED`, 503) (per `### Error Catalog`)
3. Criar `VideosService.completeUpload(userId, publicId, dto)` na ordem de `phase-03-videos/TD-08`: valida dono, status `draft` e `partNumber <= part_count`; (1) `storage.completeMultipartUpload` — `InvalidMultipartUploadError` com `reason = NoSuchUpload` segue para o passo 2 quando o objeto já existe (`headObject`), senão (e para as demais razões) lança `UploadCompletionFailedException` mantendo o vídeo em `draft`; (2) `headObject`: `contentLength > 10 GiB` → `deleteObject` + `transition(draft → error, 'FILE_TOO_LARGE: …')` + `FileTooLargeException`; `contentLength == 0` → mesmo caminho com `EMPTY_FILE`; (3) `dataSource.transaction` com `transition(draft → processing, { size_bytes })` (perder a corrida → `VideoNotInDraftException`); (4) após o commit, `VideoProcessingProducer.enqueue`; falha → `transition(processing → error, 'ENQUEUE_FAILED: …')` + `EnqueueFailedException`; retorna `{ publicId, status: 'processing' }`
4. Adicionar a rota `POST :publicId/upload/completion` em `VideosController` (`@HttpCode(202)`, `@ApiBearerAuth('access-token')`, `@ApiResponse` para 202, 400, 401, 404, 409, 413, 422 e 503 com `ApiErrorEnvelope`)
5. Importar `QueueModule` em `VideosModule` (produtor injetado na `VideosService`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ordem dos passos; `NoSuchUpload` com objeto existente continua; `FILE_TOO_LARGE` (> 10 GiB via `headObject` mockado) e `EMPTY_FILE` removem o objeto e levam a `error`; compensação `ENQUEUE_FAILED`; `transition` falso → `VideoNotInDraftException` | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais): upload multipart real de 2 partes ≥ 5 MiB → `processing` com `size_bytes` real e job na fila com `jobId` = uuid; objeto vazio → `error`/`EMPTY_FILE` e objeto removido; `ETag` inválido → continua `draft`; produtor falhando (spy) → `error`/`ENQUEUE_FAILED` | `src/videos/videos.service.integration-spec.ts` (estender) |

O limite de 10 GiB é verificado de forma estrutural (aritmética de partes e `headObject` mockado), sem enviar 10GB no CI (per `phase-03-videos/TD-09`).

**Dependencies:** SI-03.6 — fluxo de partes e controller; SI-03.4 — produtor da fila

**Acceptance criteria:**

- `POST /videos/:publicId/upload/completion` com as partes e `ETag`s realmente enviados retorna `202` com `{ publicId, status: "processing" }`
- Após o `202`, o vídeo está `processing`, `size_bytes` é igual ao tamanho real do objeto no storage e existe um job `process-video` com `jobId` igual ao uuid do vídeo na fila
- Repetir a conclusão do mesmo vídeo retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"` e não publica um segundo job
- `ETag` inválido retorna `422` com `error: "UPLOAD_COMPLETION_FAILED"` e o vídeo continua `draft` (o cliente pode repetir)
- Objeto vazio retorna `422` com `error: "EMPTY_FILE"`; o vídeo fica `error` com `error_message` iniciando em `EMPTY_FILE` e o objeto é removido do storage
- Objeto com mais de 10 GiB retorna `413` com `error: "FILE_TOO_LARGE"`; o vídeo fica `error` e o objeto é removido
- Falha ao publicar o job retorna `503` com `error: "ENQUEUE_FAILED"`; o vídeo fica `error` com `error_message` iniciando em `ENQUEUE_FAILED`
- `partNumber` maior que `partCount` retorna `400` com `error: "INVALID_PART_NUMBER"`; body inválido retorna `400` com `error: "VALIDATION_ERROR"`
- Vídeo inexistente ou de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`; requisição sem token retorna `401`

---

### SI-03.8 — MediaModule: metadados com ffprobe e thumbnail com ffmpeg

**Description:** Serviço de mídia que lê o objeto pela URL pré-assinada (sem copiar o arquivo para disco) — `ffprobe` extrai duração e metadados e `ffmpeg` gera um frame JPEG — cobre «Processamento automático do vídeo após upload (extração de duração e metadados)» e «Geração automática de thumbnail a partir de um frame do vídeo».

**Technical actions:**

1. Criar `src/media/media.constants.ts` (`FFPROBE_BIN`, `FFMPEG_BIN`, `PROBE_TIMEOUT_MS` = `60_000`, `THUMBNAIL_TIMEOUT_MS` = `120_000`, limites de `maxBuffer`, `THUMBNAIL_WIDTH` = `1280`, `THUMBNAIL_MAX_OFFSET_SECONDS` = `10`, `THUMBNAIL_OFFSET_RATIO` = `0.1`), `src/media/media.types.ts` (`MediaProbeResult`: `durationSeconds: number | null` + `metadata` com `container`, `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `size_bytes`) e `src/media/media.errors.ts` (`InvalidMediaError`, não retriável) (per `phase-03-videos/TD-05`)
2. Criar `MediaService.probe(input)` em `src/media/media.service.ts` — `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { timeout, maxBuffer, killSignal: 'SIGKILL' })` (array de argumentos, sem shell); arquivo sem stream de vídeo ou rejeitado como dado inválido (`Invalid data found when processing input`) → `InvalidMediaError`; timeout, erro HTTP do storage ou falha de spawn → erro comum (retriável)
3. Em `MediaService`, `computeThumbnailOffset(durationSeconds)` = `min(10% da duração, 10 s)` e `0` quando a duração é ausente ou ≤ 0 (per `phase-03-videos/TD-05` Revision), e `generateThumbnail(input, durationSeconds)` — `execFile('ffmpeg', ['-v', 'error', '-ss', offset, '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { encoding: 'buffer', timeout, maxBuffer, killSignal: 'SIGKILL' })` devolve o JPEG pelo stdout (sem arquivo temporário); saída vazia → `InvalidMediaError`
4. Criar `src/media/media.module.ts` (provider e export de `MediaService`)
5. Criar `src/test/media-fixtures.ts` — gera com `ffmpeg -f lavfi` (`testsrc`/`testsrc2` + `sine`) em diretório temporário do teste: MP4 de 3 s 320×240 com áudio, MP4 sem áudio, MP4 ≥ 11 MiB (bitrate alto) para multipart, arquivo só de áudio e arquivo de texto; nenhum binário versionado (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService` | Integration (ffprobe/ffmpeg reais + MinIO): probe de MP4 gerado (duração ≈ 3, 320×240, `h264`, `aac`, container); sem áudio → `audio_codec: null`; áudio-only e texto → `InvalidMediaError`; objeto inexistente (404) → erro que não é `InvalidMediaError`; thumbnail JPEG (bytes `FFD8`, largura 1280) | `src/media/media.service.integration-spec.ts` |
| `MediaService` | Unit (`execFile` mockado): offset `min(10%, 10 s)` e `0` sem duração; argumentos como array com `-ss` antes de `-i`; `timeout`/`killSignal` repassados; mapeamento do JSON do ffprobe (campos ausentes → `null`, `bit_rate` string → number); classificação dos erros | `src/media/media.service.spec.ts` |

**Dependencies:** SI-03.1 — ffmpeg/ffprobe na imagem; SI-03.3 — URLs pré-assinadas internas para os testes de integração

**Acceptance criteria:**

- O probe de um MP4 de 3 s, 320×240, com áudio, servido por URL pré-assinada do MinIO, retorna `durationSeconds` ≈ 3, `width` 320, `height` 240, `video_codec` `h264` e `audio_codec` `aac`
- O probe de um arquivo apenas de áudio ou de um arquivo de texto rejeita com `InvalidMediaError`
- O probe de uma URL pré-assinada de objeto inexistente rejeita com um erro diferente de `InvalidMediaError`
- O thumbnail gerado é um JPEG de largura 1280
- O frame do thumbnail é escolhido em `min(10% da duração, 10 s)`; com duração ausente ou ≤ 0 usa o frame em `0 s`
- Um ffprobe/ffmpeg que excede o timeout é encerrado e a chamada rejeita com erro

---

### SI-03.9 — Video worker: processor BullMQ, idempotência e tratamento de falha

**Description:** Container `video-worker` (Nest application context, mesma base de código da API) que consome `video-processing` com concorrência 1, processa apenas vídeos em `processing`, persiste metadados/thumbnail e trata falhas conforme o ciclo de status — cobre «Serviço de processamento em segundo plano (filas)» e a execução de «Processamento automático do vídeo após upload» e «Geração automática de thumbnail».

**Technical actions:**

1. Criar `src/video-worker/video-processing.service.ts` — `process(videoId)`: carrega o vídeo (ausente → `UnrecoverableError`); status diferente de `processing` → no-op (idempotência, per `phase-03-videos/TD-08`); `storage.presignInternalGetUrl(storage_key)` → `media.probe` → `media.generateThumbnail` → `storage.putObject(thumbnail_key, jpeg, 'image/jpeg')` → `transition(processing → ready, { duration_seconds, metadata, thumbnail_key })`; `InvalidMediaError` → `UnrecoverableError('INVALID_MEDIA: …')` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
2. Em `VideoProcessingService`, criar `handleFailure(job, error)` — ignora `job` indefinido ou de outro nome; aplica `transition(processing → error)` quando o erro é `UnrecoverableError` (`instanceof` ou `error.name`) **ou** `job.attemptsMade >= (job.opts.attempts ?? 0)`; `error_message` = a mensagem quando começa com `INVALID_MEDIA:`, senão `PROCESSING_FAILED: {mensagem}`; erros dentro do handler são logados e não relançados (contexto de background, per `nestjs-services.md`)
3. Criar `src/video-worker/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })` estendendo `WorkerHost`; `process(job)` troca por `job.name` (`process-video` → `service.process(job.data.videoId)`; outro nome → `UnrecoverableError`); `@OnWorkerEvent('failed')` delega a `service.handleFailure` (per `phase-03-videos/TD-04`)
4. Criar `src/video-worker/video-worker.module.ts` (`ConfigModule.forRoot` global com `load` de database/storage/queue e `envValidationSchema`, `TypeOrmModule.forRootAsync` como no `AppModule`, `QueueModule`, `StorageModule`, `MediaModule`, `VideosModule`, processor e service) e `src/video-worker/main.ts` (`NestFactory.createApplicationContext(VideoWorkerModule)` + `enableShutdownHooks()`, sem servidor HTTP)
5. Adicionar os scripts `start:worker` (`nest start --entryFile video-worker/main`) e `start:worker:dev` (`nest start --watch --entryFile video-worker/main`) em `package.json` e o serviço `video-worker` em `compose.yaml` (mesmo `Dockerfile.dev`, volume `.:/home/node/app`, `depends_on` com `db`, `redis` e `minio` `service_healthy`, `restart: unless-stopped`, `command` em `bash -c` que espera `node_modules/.bin/nest` existir e então executa `npm run start:worker:dev`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: no-op quando o status ≠ `processing` (sem ffprobe/`putObject`); transição para `ready` com o payload esperado; `InvalidMediaError` → `UnrecoverableError`; `handleFailure` (Unrecoverable na tentativa 1 → `error`; 1/3 e 2/3 → mantém `processing`; 3/3 → `error`; `job` indefinido → ignora) | `src/video-worker/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (DB + MinIO + ffmpeg reais): vídeo `processing` com MP4 gerado → `ready` com duração, `metadata` e thumbnail existente no storage; vídeo já `ready` → inalterado e sem novo upload; áudio-only → `UnrecoverableError` e `handleFailure` leva a `error` | `src/video-worker/video-processing.service.integration-spec.ts` |
| `VideoWorkerModule` | Integration (Redis + DB + MinIO reais, `QUEUE_PREFIX` único): o contexto consome o job publicado pelo produtor e o vídeo vira `ready`; mídia inválida → `error` na 1ª tentativa, sem retries; falha retriável (objeto ausente, job de teste com `attempts: 2` e backoff curto) → `processing` entre as tentativas e depois `error` com `PROCESSING_FAILED` | `src/video-worker/video-worker.integration-spec.ts` |

**Dependencies:** SI-03.2 — entidade/repositório; SI-03.3 — storage; SI-03.4 — fila; SI-03.8 — mídia

**Acceptance criteria:**

- O job `process-video` de um vídeo `processing` com MP4 válido leva o vídeo a `ready` com `duration_seconds`, `metadata` (`container`, `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `size_bytes`) e `thumbnail_key = videos/{publicId}/thumbnail.jpg`, e o thumbnail existe no storage como JPEG
- O job de um vídeo que não está `processing` (por exemplo `ready`) não altera a linha nem reenvia o thumbnail
- O job de um arquivo sem stream de vídeo leva o vídeo a `error` já na primeira tentativa (`attemptsMade = 1`) com `error_message` iniciando em `INVALID_MEDIA`
- Uma falha retriável mantém o vídeo em `processing` enquanto houver tentativas e o leva a `error` com `error_message` iniciando em `PROCESSING_FAILED` ao esgotá-las
- `docker compose up -d video-worker` mantém o container em execução (sem porta HTTP) e `docker compose logs video-worker` mostra a aplicação iniciada sem erros
- `docker compose up -d --scale video-worker=2 video-worker` sobe duas réplicas consumindo a mesma fila

---

### SI-03.10 — Leitura do vídeo pelo dono (GET /videos/:publicId)

**Description:** Recurso de vídeo restrito ao dono, em qualquer status, que expõe o ciclo de status, duração, metadados, mensagem de erro e a thumbnail pré-assinada — torna observável o resultado de «Pré-cadastro automático do vídeo como rascunho», «Processamento automático do vídeo» e «Geração automática de thumbnail».
**Route:** GET /videos/:publicId
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Dono do vídeo (JWT); não-dono recebe `404`

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` (`VideoResponseDto` + `VideoMetadataDto` com `@ApiProperty` explícito; campos opcionais/anuláveis com `required: false, nullable: true`, per `nestjs-dtos.md`) conforme `### API Contracts` → GET /videos/:publicId — sem expor `upload_id`, `storage_key` nem `thumbnail_key`
2. Criar `VideosService.getOwnedVideo(userId, publicId)` — resolve o canal, `findOwnedByPublicId` (inexistente ou de outro canal → `VideoNotFoundException`) e monta a resposta; `thumbnailUrl` = `storage.presignPublicGetUrl(thumbnail_key, { expiresIn: 3600 })` quando `thumbnail_key` está preenchido, senão `null` (per `phase-03-videos/TD-11`)
3. Adicionar a rota `GET :publicId` em `VideosController` (`@ApiBearerAuth('access-token')`, `@ApiResponse` para 200, 401 e 404 com `ApiErrorEnvelope`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit: projeção por status (`draft` → campos nulos; `ready` → duração, metadata e `thumbnailUrl`; `error` → `errorMessage`); não-dono → `VideoNotFoundException` | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.getOwnedVideo` | Integration (DB + MinIO reais): `thumbnailUrl` pré-assinada baixa o JPEG do storage | `src/videos/videos.service.integration-spec.ts` (estender) |

**Dependencies:** SI-03.5 — `VideosService`/`VideosController`; SI-03.3 — URLs pré-assinadas

**Acceptance criteria:**

- `GET /videos/:publicId` do dono de um vídeo `draft` retorna `200` com `status: "draft"` e `durationSeconds`, `metadata` e `thumbnailUrl` nulos
- `GET /videos/:publicId` do dono de um vídeo `ready` retorna `200` com `durationSeconds`, `metadata` e uma `thumbnailUrl` cujo host é o de `S3_PUBLIC_ENDPOINT` e que baixa um JPEG
- `GET /videos/:publicId` de um vídeo `error` retorna `errorMessage` preenchido
- A resposta não contém `upload_id`, `storage_key` nem `thumbnail_key`
- `publicId` inexistente e `publicId` de vídeo de outro canal retornam a mesma resposta `404` com `error: "VIDEO_NOT_FOUND"`
- Requisição sem token retorna `401`

---

### SI-03.11 — Streaming e download (GET /videos/:publicId/stream e /download)

**Description:** Endpoints públicos que autorizam apenas vídeos `ready` e respondem `302` para uma URL pré-assinada, de modo que o cliente reproduz (com `Range`/`206`) ou baixa o arquivo diretamente do storage — cobre «Reprodução via streaming (sem necessidade de download completo)» e «Download do vídeo pelo usuário».
**Route:** GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Público (`@Public()`); somente vídeos `ready`

**Technical actions:**

1. Criar `src/videos/download-filename.util.ts` — `buildDownloadFilename(title, ext, fallback)` (`{title}.{ext}` com caracteres fora de letras/números/espaço/`.`/`_`/`-` trocados por `_`; resultado vazio → `original_filename`) e `buildContentDisposition(filename)` (`attachment; filename="{fallback ASCII}"; filename*=UTF-8''{percent-encoded}`) (per `phase-03-videos/TD-10`)
2. Adicionar a `src/common/exceptions/domain.exception.ts` a exceção `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) e criar `VideosService.getStreamUrl(publicId)` e `getDownloadUrl(publicId)` — `findByPublicId` sem escopo de dono (inexistente → `VideoNotFoundException`), exige status `ready` (senão `VideoNotReadyException`) e usa `storage.presignPublicGetUrl(storage_key, { expiresIn: 3600 })`; o download acrescenta `responseContentDisposition` (per `phase-03-videos/TD-07`)
3. Adicionar as rotas `@Public() @Get(':publicId/stream')` e `@Public() @Get(':publicId/download')` em `VideosController` com `@Redirect()` retornando `{ url, statusCode: 302 }`; OpenAPI com `@ApiResponse` 302, 404 e 409 (`ApiErrorEnvelope`) e **sem** `@ApiBearerAuth` (per `nestjs-controllers.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildDownloadFilename` / `buildContentDisposition` | Unit: sanitização, fallback para o nome original, caracteres não ASCII | `src/videos/download-filename.util.spec.ts` |
| `VideosService.getStreamUrl` / `getDownloadUrl` | Unit: inexistente → `VideoNotFoundException`; `draft`/`processing`/`error` → `VideoNotReadyException`; `ready` → argumentos de presign (TTL; disposition só no download) | `src/videos/videos.service.spec.ts` (estender) |
| `VideosService.getStreamUrl` / `getDownloadUrl` | Integration (DB + MinIO reais): URL de stream com `Range: bytes=0-99` → `206` com `Content-Range`; URL de download → `Content-Disposition: attachment` com o nome e corpo igual ao original | `src/videos/videos.service.integration-spec.ts` (estender) |

**Dependencies:** SI-03.5 — `VideosService`/`VideosController`; SI-03.3 — URLs pré-assinadas

**Acceptance criteria:**

- `GET /videos/:publicId/stream` sem token, de um vídeo `ready`, retorna `302` com `Location` iniciando em `S3_PUBLIC_ENDPOINT`; seguir o `Location` com `Range: bytes=0-99` retorna `206` com 100 bytes e `Content-Range`
- `GET /videos/:publicId/download` sem token, de um vídeo `ready`, retorna `302`; seguir o `Location` retorna o arquivo original com `Content-Disposition: attachment; filename="{title}.{ext}"`
- Um título com `/`, `\` ou aspas gera um nome de arquivo de download sem esses caracteres
- Stream e download de um vídeo `draft`, `processing` ou `error` retornam `409` com `error: "VIDEO_NOT_READY"`
- Stream e download de um `publicId` inexistente retornam `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.12 — Pipeline ponta a ponta: upload, worker, streaming e download (E2E)

**Description:** Valida o fluxo completo contra a infraestrutura real do Compose — upload multipart por URLs pré-assinadas, conclusão, processamento pelo worker, leitura do status, streaming com `Range` e download — e a entrega de «URLs únicas geradas», «streaming funcionando» e «processamento automático do vídeo» como um todo.

**Technical actions:**

1. Criar `src/test/worker-test-helpers.ts` — `startTestWorker(queuePrefix)` (compila `VideoWorkerModule` com `Test.createTestingModule` e inicia o application context com o `QUEUE_PREFIX` do teste) e `waitForVideoStatus(dataSource, publicId, status, timeoutMs)` (polling no banco com timeout explícito)
2. Criar `test/video-pipeline.e2e-spec.ts` — sobe a API (`AppModule` com os `ValidationPipe`/filtros de `main.ts`) com `QUEUE_PREFIX` único por execução; usa os helpers de autenticação (SI-03.1), `media-fixtures` (SI-03.8) e `putPartsViaPresignedUrls` (SI-03.3); limpa o storage do `ThrottlerGuard` em `beforeEach` e entre as etapas do fluxo, pois o limite global de 10 req/min por IP também vale para `/videos*` (per `auth-jwt.md`); o worker só é iniciado depois de validar o estado `processing`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo (API + worker + MinIO + Redis + PostgreSQL + FFmpeg) | E2E: upload multipart de 3 partes (2 × ≥ 5 MiB + resto) por URLs pré-assinadas; conclusão `202`; estado `processing` e `stream` `409` antes do worker; worker → `ready`; `GET /videos/:publicId` com duração/metadata/thumbnail; stream `302` → `Range` `206`; download `302` → bytes idênticos; arquivo de texto como `video/mp4` → `error`; `publicId` distintos | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.7 — conclusão do upload; SI-03.9 — worker; SI-03.10 — leitura; SI-03.11 — stream/download

**Acceptance criteria:**

- Um upload com `POST /videos`, `part-urls` e `PUT` de 3 partes (2 × ≥ 5 MiB + resto) seguido de `completion` retorna `202`, e antes de o worker consumir o job `GET /videos/:publicId` retorna `processing` e `GET /videos/:publicId/stream` retorna `409` com `error: "VIDEO_NOT_READY"`
- Após o worker consumir o job, `GET /videos/:publicId` retorna `ready` com `durationSeconds`, `metadata` e uma `thumbnailUrl` que baixa um JPEG
- `GET /videos/:publicId/stream` retorna `302` e o `Location` aceita `Range: bytes=0-99` com `206` e 100 bytes servidos pelo storage
- `GET /videos/:publicId/download` retorna `302` e o `Location` entrega bytes idênticos ao arquivo enviado, com `Content-Disposition: attachment`
- Um arquivo de texto enviado como `video/mp4` leva o vídeo a `error` com `errorMessage` iniciando em `INVALID_MEDIA`, e o `stream` desse vídeo retorna `409`
- Dois vídeos criados em sequência recebem `publicId` distintos e URLs de stream distintas

---

### SI-03.13 — Contrato OpenAPI, exemplos `api.http` e documentação

**Description:** Fecha a fase exportando o contrato OpenAPI dos endpoints de vídeo, adicionando o fluxo de exemplo ao `api.http` e atualizando `CLAUDE.md` (raiz e `nestjs-project/`) e o diagrama de arquitetura para refletir MinIO, Redis/BullMQ e o `video-worker` implementados.

**Technical actions:**

1. Executar `npm run openapi:export` (dentro do container) para regenerar `nestjs-project/openapi.json` com os seis endpoints de `/videos` e estender `src/openapi-export.integration-spec.ts` com as verificações de contrato dos vídeos
2. Adicionar a seção Videos a `nestjs-project/api.http` — login, `POST /videos`, `part-urls`, `PUT` de parte ao `S3_PUBLIC_ENDPOINT` (com a nota sobre capturar o `ETag`), `completion`, `GET /videos/:publicId`, `stream` e `download` — reutilizando `@accessToken`
3. Atualizar `nestjs-project/CLAUDE.md` — serviços `minio` (portas `9000`/`9001`), `redis` e `video-worker`; verificações de prontidão (`docker compose exec redis redis-cli ping`, `curl http://localhost:9000/minio/health/live`); comandos do worker (`docker compose up -d video-worker`, `docker compose logs -f video-worker`, `--scale`); `docker compose build` após mudar o `Dockerfile.dev`; variáveis de ambiente novas; convenções de teste com infra real (override de `S3_PUBLIC_ENDPOINT`, `QUEUE_PREFIX` único, fixtures geradas por `ffmpeg`, sem binários versionados); a seção "Test Type Selection" passa a citar MinIO/Redis como dependências de integração
4. Atualizar o `CLAUDE.md` da raiz — Architecture/Repository Structure (fila = BullMQ + Redis, Object Storage = MinIO, Video Worker = container `video-worker`) e a exceção documentada à regra de Docker Networking (`S3_PUBLIC_ENDPOINT` com `localhost` apenas para URLs entregues ao cliente), e trocar o `Message Queue` `TBD` em `docs/diagrams/software-arch.mermaid` por `BullMQ / Redis`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Documento OpenAPI exportado | Integration: os seis paths de `/videos` existem com `summary`; operações protegidas declaram `access-token` e `stream`/`download` não; respostas de erro referenciam `ApiErrorEnvelope` | `src/openapi-export.integration-spec.ts` (estender) |

**Dependencies:** SI-03.12 — endpoints e fluxo completos validados

**Acceptance criteria:**

- `npm run openapi:export` gera `openapi.json` contendo `POST /videos`, `POST /videos/{publicId}/upload/part-urls`, `POST /videos/{publicId}/upload/completion`, `GET /videos/{publicId}`, `GET /videos/{publicId}/stream` e `GET /videos/{publicId}/download`, cada um com `summary` e `description`
- As operações protegidas de `/videos` declaram o esquema `access-token` e `stream`/`download` não declaram `security`
- Toda resposta de erro das operações de `/videos` referencia `#/components/schemas/ApiErrorEnvelope`
- O fluxo da seção Videos de `api.http` (login → draft → part-urls → PUT → completion → status → stream → download) é executável contra o ambiente local
- `CLAUDE.md` (raiz e `nestjs-project/`) e `docs/diagrams/software-arch.mermaid` descrevem `minio`, `redis`/BullMQ e `video-worker` sem a fila marcada como `TBD`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; also the BullMQ `jobId` (per `phase-03-videos/TD-01`) |
| public_id | varchar(11) | unique, not null | Random 11-char base64url (`crypto.randomBytes(8)`); used in `/videos/:publicId` and storage keys (per `phase-03-videos/TD-06`) |
| channel_id | uuid | FK → channels.id, not null | Owner channel (one channel per user, Phase 02) |
| title | varchar(100) | not null | Defaults to the filename stem trimmed to 100 chars (per `phase-03-videos/TD-10`) |
| original_filename | varchar(255) | not null | Client-declared display name; never used to build storage keys |
| content_type | varchar(100) | not null | Must belong to the allow-list below (per `phase-03-videos/TD-10`) |
| status | enum `video_status` | not null, default `'draft'` | Values: `draft`, `processing`, `ready`, `error` (per `phase-03-videos/TD-08`) |
| storage_key | varchar(255) | not null | `videos/{public_id}/original.{ext}` (per `phase-03-videos/TD-03`) |
| thumbnail_key | varchar(255) | nullable | `videos/{public_id}/thumbnail.jpg`; set by the worker when the video becomes `ready` |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; set right after `CreateMultipartUpload`, never exposed by the API |
| part_count | integer | not null | Parts planned at draft creation: `ceil(sizeBytes / 64 MiB)` (per `phase-03-videos/TD-02`) |
| size_bytes | bigint | nullable | Actual `HeadObject` `ContentLength` persisted at completion (TypeORM transformer string → number; ≤ 10 GiB fits a JS safe integer) |
| duration_seconds | double precision | nullable | From ffprobe; set by the worker |
| metadata | jsonb | nullable | `{ container, width, height, video_codec, audio_codec, bit_rate, size_bytes }` (per `phase-03-videos/TD-05`) |
| error_message | text | nullable | `"<CODE>: <detail>"` when `status = 'error'` (see Error Catalog → Persisted failure reasons) |
| created_at | timestamptz | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamptz | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** `Video` many-to-one `Channel` via `channel_id`; `Channel` one-to-many `Video` (both sides declared, per `nestjs-entities.md`)
**Indexes:** unique on `public_id`; `(channel_id)` — FK lookup

#### Video status lifecycle (per `phase-03-videos/TD-08`)

| From | To | Owner | Trigger |
|------|----|-------|---------|
| `draft` | `processing` | API | Upload completion succeeded and the size check passed (transaction), before the job is published |
| `draft` | `error` | API | Completed object is unusable: `ContentLength > 10 GiB` → `FILE_TOO_LARGE`; `ContentLength == 0` → `EMPTY_FILE` (object deleted) |
| `processing` | `error` | API | Publishing the job failed → `ENQUEUE_FAILED` (HTTP `503`) |
| `processing` | `ready` | Worker | ffprobe metadata + thumbnail persisted |
| `processing` | `error` | Worker | `failed` handler: `UnrecoverableError` **or** `job.attemptsMade >= job.opts.attempts` |

Any other transition is rejected: every transition is a conditional `UPDATE … WHERE id = :id AND status = :from` and is a no-op when the row is not in the expected state. `error` is terminal in this phase (no re-processing endpoint); orphan `draft` rows are kept (draft management belongs to Phase 04, per `phase-03-videos/TD-02`).

#### Media-type allow-list (per `phase-03-videos/TD-10`)

| contentType | Storage extension |
|-------------|-------------------|
| `video/mp4` | `mp4` |
| `video/webm` | `webm` |
| `video/quicktime` | `mov` |
| `video/x-matroska` | `mkv` |

The extension is always derived from this map, never from `filename`.

#### Object storage layout (non-relational, per `phase-03-videos/TD-03`)

| Item | Value |
|------|-------|
| Bucket | `streamtube` (`S3_BUCKET`), created idempotently at startup by `StorageService` (`HeadBucket` → `CreateBucket`) |
| Original video key | `videos/{public_id}/original.{ext}` |
| Thumbnail key | `videos/{public_id}/thumbnail.jpg` (`image/jpeg`, width 1280, height auto/even) |
| Upload limits | max declared size `10 × 1024³` bytes; fixed `partSize` `64 MiB` (≤ 160 parts); presigned URL TTL `3600` s (per `phase-03-videos/TD-02`) |

### API Contracts

All bodies are JSON with camelCase fields (per `phase-03-videos/TD-02`, `TD-10`, `TD-11`). Errors use the inherited envelope `{ statusCode, error, message }` (see Error Catalog). Every endpoint except `stream` and `download` requires `Authorization: Bearer <access token>` (global JWT guard, `@Public()` opt-out only on the two delivery endpoints).

#### POST /videos (SI-03.5)

Pre-registers the draft video and starts the S3 multipart upload (per `phase-03-videos/TD-02` step 1).

**Request headers:**
- Authorization: Bearer access token
- Content-Type: application/json

**Request body:**
- filename: string, required — 1–255 characters (display/original name)
- contentType: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- sizeBytes: integer, required — `1 … 10737418240` (10 GiB); only used to plan the part count
- title: string, optional — 1–100 characters; defaults to the filename without its extension, trimmed to 100 characters

**Response 201:**
- publicId: string — 11 characters, `[A-Za-z0-9_-]`
- status: string — `"draft"`
- title: string
- partSize: integer — `67108864` (64 MiB)
- partCount: integer — `ceil(sizeBytes / partSize)`, `1 … 160`

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (missing field, `contentType` outside the allow-list, `sizeBytes` outside `1 … 10 GiB` or non-integer, `title`/`filename` too long)
- 401: missing or invalid access token
- 404 CHANNEL_NOT_FOUND: authenticated user has no channel (invariant violation)

---

#### POST /videos/:publicId/upload/part-urls (SI-03.6)

Returns presigned `UploadPart` URLs for the requested part numbers (per `phase-03-videos/TD-02` step 2). The client `PUT`s the raw part bytes to each URL and reads the `ETag` response header.

**Request headers:**
- Authorization: Bearer access token
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1–160 unique items, each `1 … partCount`

**Response 200:**
- expiresInSeconds: integer — `3600`
- urls: array of `{ partNumber: integer, url: string }` — one entry per requested part, signed against `S3_PUBLIC_ENDPOINT`

**Error responses:**
- 400 VALIDATION_ERROR: `partNumbers` missing, empty, with duplicates, with non-integers or `< 1`
- 400 INVALID_PART_NUMBER: a requested part number is greater than the video's `partCount`
- 401: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another channel
- 409 VIDEO_NOT_IN_DRAFT: video is not in `draft`

---

#### POST /videos/:publicId/upload/completion (SI-03.7)

Completes the multipart upload, moves the video to `processing` and publishes the processing job (per `phase-03-videos/TD-02` step 4 and `TD-08`). Order: (1) `CompleteMultipartUpload`; (2) `HeadObject` size check; (3) transaction `draft → processing`; (4) publish job.

**Request headers:**
- Authorization: Bearer access token
- Content-Type: application/json

**Request body:**
- parts: array, required — 1–160 items of `{ partNumber: integer (1 … partCount, unique), etag: string (non-empty, as returned by storage) }`

**Response 202:**
- publicId: string
- status: string — `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: `parts` missing/empty/malformed or duplicate `partNumber`
- 400 INVALID_PART_NUMBER: a `partNumber` is greater than the video's `partCount`
- 401: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another channel
- 409 VIDEO_NOT_IN_DRAFT: video is not in `draft` (e.g., completion repeated)
- 413 FILE_TOO_LARGE: completed object `ContentLength > 10 GiB` — object deleted, video `draft → error`
- 422 EMPTY_FILE: completed object `ContentLength == 0` — object deleted, video `draft → error`
- 422 UPLOAD_COMPLETION_FAILED: storage rejected step 1 (invalid parts/ETags, parts out of order, part too small, unknown upload and no object) — video stays `draft`, the client can retry
- 503 ENQUEUE_FAILED: publishing the job failed — video `processing → error`

---

#### GET /videos/:publicId (SI-03.10)

Owner-only video resource in any status (per `phase-03-videos/TD-11`).

**Request headers:**
- Authorization: Bearer access token

**Response 200:**
- publicId: string
- title: string
- status: string — `draft | processing | ready | error`
- originalFilename: string
- contentType: string
- sizeBytes: integer | null — actual size, `null` until completion
- durationSeconds: number | null — `null` until `ready`
- metadata: object | null — `{ container: string, width: integer | null, height: integer | null, video_codec: string | null, audio_codec: string | null, bit_rate: integer | null, size_bytes: integer }`; `null` until `ready`
- errorMessage: string | null — populated when `status = "error"`
- thumbnailUrl: string | null — presigned GET (TTL 3600 s, signed against `S3_PUBLIC_ENDPOINT`); `null` until `ready`
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 401: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another channel (existence is not leaked)

---

#### GET /videos/:publicId/stream (SI-03.11)

Public. Authorises (video must be `ready`) and redirects to a presigned GET so the client streams directly from storage, which natively serves `Range` / `206 Partial Content` (per `phase-03-videos/TD-07`).

**Response 302:**
- Location: presigned GET URL of `storage_key`, signed against `S3_PUBLIC_ENDPOINT`, TTL 3600 s

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`
- 409 VIDEO_NOT_READY: video is not in `ready`

---

#### GET /videos/:publicId/download (SI-03.11)

Public. Same rules as `stream`; the presigned URL carries `response-content-disposition=attachment; filename="…"` where the filename is `{title}.{ext}` sanitised to a filesystem-safe string, falling back to the stored `original_filename` (per `phase-03-videos/TD-07`, `TD-10`).

**Response 302:**
- Location: presigned GET URL with `response-content-disposition` override, TTL 3600 s

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`
- 409 VIDEO_NOT_READY: video is not in `ready`

---

#### Validation Rules — Videos

| Field | Rule | Applies to |
|-------|------|------------|
| filename | string, 1–255 characters | POST /videos |
| contentType | one of the allow-list in Data Model | POST /videos |
| sizeBytes | integer, `1 … 10737418240` | POST /videos |
| title | optional string, 1–100 characters | POST /videos |
| partNumbers | integer array, 1–160 unique items, each `≥ 1`; each `≤ partCount` enforced by the service (`INVALID_PART_NUMBER`) | POST …/part-urls |
| parts[].partNumber | integer `≥ 1`, unique within the array; `≤ partCount` enforced by the service | POST …/completion |
| parts[].etag | non-empty string | POST …/completion |

Validation failures are produced by the global `ValidationPipe` + `ValidationExceptionFilter` (`400 VALIDATION_ERROR`); no new validation error code is introduced.

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ (draft is created under the caller's own channel) |
| POST /videos/:publicId/upload/part-urls | ✗ | ✗ | ✓ (non-owner → `404 VIDEO_NOT_FOUND`) |
| POST /videos/:publicId/upload/completion | ✗ | ✗ | ✓ (non-owner → `404 VIDEO_NOT_FOUND`) |
| GET /videos/:publicId | ✗ | ✗ | ✓ (non-owner → `404 VIDEO_NOT_FOUND`) |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ (only when `ready`) |
| GET /videos/:publicId/download | ✓ | ✓ | ✓ (only when `ready`) |

Only the two delivery endpoints carry `@Public()`; every other route stays protected by the global `JwtAuthGuard`. Ownership = `video.channel_id` equals the channel of the JWT `sub` user; visibility (public/unlisted) is explicitly Phase 04 (per `phase-03-videos/TD-07`, `TD-08`, `TD-11`). Note: the global `ThrottlerGuard` (10 req/min per IP, registered by `AuthModule`) also applies to these routes — it is inherited, not changed in this phase.

### Error Catalog

**Error response format:** inherited from Phase 02 — `{ statusCode: number, error: string, message: string }`, produced by `DomainExceptionFilter` from `DomainException` subclasses (`errorCode`, `httpStatus`, `message`); validation errors keep `error: "VALIDATION_ERROR"`. New exceptions are added to `src/common/exceptions/domain.exception.ts`.

| errorCode | HTTP | Message | Trigger |
|-----------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | `publicId` unknown, or (owner-only routes) video belongs to another channel |
| CHANNEL_NOT_FOUND | 404 | Channel not found | `POST /videos` by an authenticated user that has no channel |
| VIDEO_NOT_IN_DRAFT | 409 | Video is not in draft status | `part-urls` or `completion` on a video whose status is not `draft` |
| VIDEO_NOT_READY | 409 | Video is not ready | `stream` or `download` on a video whose status is not `ready` |
| INVALID_PART_NUMBER | 400 | Part number is out of range | A requested/completed `partNumber` is greater than the video's `part_count` |
| UPLOAD_COMPLETION_FAILED | 422 | Multipart upload could not be completed | `CompleteMultipartUpload` rejected (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload` without an existing object); video stays `draft` |
| FILE_TOO_LARGE | 413 | File exceeds the 10 GiB limit | `HeadObject` `ContentLength > 10 GiB` at completion; object deleted, video `draft → error` |
| EMPTY_FILE | 422 | Uploaded file is empty | `HeadObject` `ContentLength == 0` at completion; object deleted, video `draft → error` |
| ENQUEUE_FAILED | 503 | Video processing could not be scheduled | Publishing the `process-video` job failed; video `processing → error` |
| VALIDATION_ERROR | 400 | _(field errors array)_ | Inherited — any request body failing DTO validation (including the content-type allow-list and the size range) |

**Persisted failure reasons (`videos.error_message`, format `"<CODE>: <detail>"`):**

| Code | Set by | Trigger |
|------|--------|---------|
| FILE_TOO_LARGE | API | See table above |
| EMPTY_FILE | API | See table above |
| ENQUEUE_FAILED | API | See table above |
| INVALID_MEDIA | Worker | ffprobe finds no video stream or cannot parse the file (`UnrecoverableError`, no retries) |
| PROCESSING_FAILED | Worker | Retriable failure with no attempts left (`job.attemptsMade >= job.opts.attempts`) |

### Events/Messages

Queue backend: BullMQ on Redis (`redis:7-alpine`, `--maxmemory-policy noeviction`), queue `video-processing` (per `phase-03-videos/TD-01`). `@nestjs/bullmq` is pinned to `^11.0.5` (CommonJS; 12.x is ESM-only and fails under Jest 30) and `ioredis@^5.11.1` is an explicit dependency (per `library-refs.md`).

#### video-processing / process-video

**Payload:**

```json
{ "videoId": "uuid", "publicId": "string (11 chars)" }
```

**Job options:** `jobId` = `<video uuid>` (idempotent publish — adding an existing id is silently ignored); `attempts: 3`; `backoff: { type: 'exponential', delay: 5000 }` (retries after ≈ 5 s then ≈ 10 s); `removeOnComplete` / `removeOnFail` bounded by count (the job id of a retained job blocks re-adding, acceptable because `error` is terminal in this phase).
**Producer:** `VideoProcessingProducer` called by `VideosService.completeUpload` after the `draft → processing` transaction commits (per `phase-03-videos/TD-01`, `TD-08`)
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing', { concurrency: 1 })`, extends `WorkerHost`) in the `video-worker` container (per `phase-03-videos/TD-04`); the BullMQ worker has no per-job-name handler, so `process()` switches on `job.name`
**Trigger:** upload completion accepted (`202`) — the video is `processing`
**Delivery semantics:** at-least-once with an idempotent consumer: the processor acts only on videos in `processing` (any other status is a no-op) (per `phase-03-videos/TD-08`). Enqueue is not transactional with PostgreSQL; a publish failure is compensated by marking the video `error` / `ENQUEUE_FAILED` and answering `503`; a crash between commit and publish is not recovered in this phase (accepted limitation of `TD-08` Option A).

**Consumer outcomes:**
- Success → `processing → ready` with `duration_seconds`, `metadata`, `thumbnail_key`
- Invalid media (no video stream / unparsable file) → `UnrecoverableError`, fails immediately without retries
- Any other error → BullMQ retries per the backoff above

#### video-processing / failed (BullMQ worker event)

**Payload:** `(job: Job | undefined, error: Error, prev: string)` — fires on **every** failed attempt; `attemptsMade` already counts the failed attempt.

**Producer:** BullMQ `Worker` (per `phase-03-videos/TD-08`)
**Consumer:** `@OnWorkerEvent('failed')` handler of `VideoProcessingProcessor`, delegating to `VideoProcessingService.handleFailure`
**Trigger:** a job attempt threw
**Delivery semantics:** best-effort (event handler; errors are logged, never rethrown). The handler ignores `job === undefined` and sets `processing → error` only when the error is an `UnrecoverableError` (`instanceof` or `err.name === 'UnrecoverableError'`) **or** `job.attemptsMade >= job.opts.attempts`; otherwise the job is retried and the video stays `processing`.

---

## Dependency Map

```
SI-03.1 (root — infra, dependências, configuração, suporte de testes)
├── SI-03.2 — entidade Video + repositório
├── SI-03.3 — StorageService
├── SI-03.4 — QueueModule + produtor
└── SI-03.8 — MediaService (também depende de SI-03.3)

SI-03.2 + SI-03.3
└── SI-03.5 — POST /videos (rascunho)
    ├── SI-03.6 — part-urls
    │   └── SI-03.7 — completion (também depende de SI-03.4)
    ├── SI-03.10 — GET /videos/:publicId (também depende de SI-03.3)
    └── SI-03.11 — stream + download (também depende de SI-03.3)

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.8
└── SI-03.9 — video worker

SI-03.7 + SI-03.9 + SI-03.10 + SI-03.11
└── SI-03.12 — pipeline E2E
    └── SI-03.13 — OpenAPI, api.http e documentação
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (paralelas) → SI-03.5 → SI-03.6 → SI-03.7; SI-03.8 (após SI-03.3) → SI-03.9 (após SI-03.4 e SI-03.8); SI-03.10 e SI-03.11 (após SI-03.5) → SI-03.12 → SI-03.13

---

## Deliverables

- [ ] SI-03.1 — Infra: ffmpeg, MinIO, Redis, dependências, configuração e suporte de testes
- [ ] SI-03.2 — Entidade Video, migration, repositório e identificador público
- [ ] SI-03.3 — StorageModule e StorageService (S3/MinIO)
- [ ] SI-03.4 — QueueModule e produtor do job de processamento
- [ ] SI-03.5 — Pré-cadastro do vídeo como rascunho (POST /videos)
- [ ] SI-03.6 — URLs pré-assinadas de partes (POST /videos/:publicId/upload/part-urls)
- [ ] SI-03.7 — Conclusão do upload e publicação do job (POST /videos/:publicId/upload/completion)
- [ ] SI-03.8 — MediaModule: metadados com ffprobe e thumbnail com ffmpeg
- [ ] SI-03.9 — Video worker: processor BullMQ, idempotência e tratamento de falha
- [ ] SI-03.10 — Leitura do vídeo pelo dono (GET /videos/:publicId)
- [ ] SI-03.11 — Streaming e download (GET /videos/:publicId/stream e /download)
- [ ] SI-03.12 — Pipeline ponta a ponta: upload, worker, streaming e download (E2E)
- [ ] SI-03.13 — Contrato OpenAPI, exemplos `api.http` e documentação

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
