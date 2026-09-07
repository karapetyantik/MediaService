# MediaService

Загрузка и учёт файлов платформы **Tapik**: presigned-загрузка в S3-совместимое хранилище (MinIO), дедупликация по контент-хэшу, верификация вложений для ChatService, приём готовых превью от ImageProxyService.

## Роль в системе

```
Клиент ──1. POST /media/upload-url──▶ MediaService ──PUT (presigned)──▶ MinIO
Клиент ──2. PUT файла напрямую в MinIO──────────────────────────────────▶
Клиент ──3. POST /media/:id/confirm──▶ MediaService ──HeadObject/GetObject──▶ MinIO
                                              │
                                              ├──file.uploaded (RMQ)──▶ ImageProxyService
                                              │◀──image.processed (RMQ)──┤
                                              │
                                              ├──avatar.updated (RMQ)──▶ UserService
                                              │
ChatService ──gRPC VerifyMedia (x-internal-key)──▶ MediaService
```

Клиент грузит байты файла напрямую в MinIO по presigned URL — сам MediaService файл через себя не проксирует.

## Технологии

- **NestJS 11**, гибрид: HTTP + gRPC-сервер + RabbitMQ (producer и consumer)
- **PostgreSQL** через **Prisma**
- **S3-совместимое хранилище** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) — MinIO
- **file-type** — сверка реального содержимого файла с заявленным MIME-типом по магическим байтам
- **gRPC** — сервер `MediaInternal.VerifyMedia` для ChatService
- Path-алиасы: `@common/*`, `@modules/*`, `@proto/*`

## Возможности

- Двухфазная загрузка: `upload-url` (presigned PUT) → клиент грузит файл в MinIO напрямую → `confirm` (сервер проверяет, что файл реально появился, каков его размер и содержимое).
- Лимит на размер файла (`MAX_UPLOAD_BYTES`, по умолчанию 200MB) — проверяется дважды: заявленный размер в DTO и **реальный** размер объекта в MinIO при подтверждении.
- Проверка содержимого по магическим байтам (`file-type`) — заявленный `mimeType` должен совпадать с фактическим форматом файла; несовпадение отклоняет загрузку и удаляет объект. `application/octet-stream` пропускает эту проверку (общий бинарный тип).
- Дедупликация: если у пользователя уже есть подтверждённый файл с тем же ETag/типом/назначением — новый объект удаляется, возвращается ссылка на существующий (порядок удаления: сначала S3, потом БД — чтобы при сбое максимум осталась лишняя видимая запись, а не «осиротевший» объект в бакете).
- Отдельный поток для аватаров: обрезка (`cropX/cropY/cropSize`) передаётся в ImageProxyService, готовый URL публикуется как `avatar.updated`.
- Внутренний gRPC `VerifyMedia` — ChatService проверяет владельца и статус вложения перед тем как разрешить прикрепить его к сообщению.

## HTTP API (`/media`)

Все эндпоинты требуют `JwtAuthGuard`.

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/media/upload-url` | Получить `mediaId` + presigned URL для загрузки |
| `POST` | `/media/:mediaId/confirm` | Подтвердить, что файл загружен; для аватара — передать crop |

### `POST /media/upload-url`

```json
{ "fileName": "photo.png", "mimeType": "image/png", "sizeBytes": 204800, "purpose": "attachment" }
```
→ `{ "mediaId": "uuid", "uploadUrl": "https://minio.../presigned...", "objectKey": "uid/uuid.png" }`

### `POST /media/:mediaId/confirm`

```json
{ "cropX": 0, "cropY": 0, "cropSize": 512 }
```
`cropX/cropY/cropSize` обязательны только для `purpose: "avatar"`.

## Внутренний gRPC-сервер: `MediaInternal`

Proto: `src/proto/media.proto`. Защищён `InternalGrpcAuthGuard` (metadata `x-internal-key`).

| RPC | Вызывается кем | Назначение |
|---|---|---|
| `VerifyMedia` | ChatService | Проверить, что вложение подтверждено и принадлежит отправителю, вернуть URL/placeholder |

## RabbitMQ

**Публикует:** `file.uploaded` (очередь `media_events`, слушает ImageProxyService), `avatar.updated` (очередь `user_events`, слушает UserService).

**Потребляет:** `image.processed` (очередь `media_processing_events`, от ImageProxyService) — сохраняет варианты (`thumbnail`/`medium`/`avatar`/`placeholder`) в запись файла.

## Переменные окружения

| Переменная | Обязательна | Назначение |
|---|---|---|
| `PORT` | нет (3004) | HTTP-порт |
| `DATABASE_URL` | да | PostgreSQL |
| `JWT_SECRET` | да | Проверка access-токенов |
| `RABBITMQ_URL` | да | AMQP |
| `MINIO_ENDPOINT` / `MINIO_PORT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | да | S3-совместимое хранилище |
| `MINIO_BUCKET` | да | Бакет для вложений |
| `AVATAR_BUCKET` | да | Отдельный бакет для аватаров |
| `INTERNAL_API_KEY` | да | Shared-secret для входящего gRPC от ChatService |
| `MAX_UPLOAD_BYTES` | нет (200MB) | Максимальный размер файла |

## Структура проекта

```
src/
├── main.ts               # HTTP + gRPC(:5002) + RMQ bootstrap
├── common/
│   ├── auth/              # JwtStrategy, JwtAuthGuard, AuthenticatedRequest
│   └── prisma/             # PrismaService
├── modules/
│   ├── dto/                # RequestUploadDto, ConfirmUploadDto
│   ├── s3/                 # S3Service (presign, head, download-range, delete)
│   └── media/
│       ├── media.controller.ts / media.service.ts
│       ├── media-events.controller.ts    # image.processed consumer
│       ├── upload-limits.ts               # MAX_UPLOAD_BYTES
│       └── grpc-media/                    # MediaInternal сервер + guard
└── proto/
    └── media.proto
```

## Запуск

```bash
npm install
npx prisma generate
npx prisma migrate deploy

npm run start:dev
npm run build && npm run start:prod
npm run test
npm run lint
```

## Безопасность

- Реальный размер и содержимое файла проверяются на сервере, а не только на клиенте — заявленным метаданным не доверяем.
- Внутренний gRPC-эндпоинт `VerifyMedia` защищён shared-secret — раньше был доступен любому в сети без аутентификации.
- Порядок удаления при дедупликации (S3 → БД) минимизирует риск «осиротевших» объектов в хранилище.
