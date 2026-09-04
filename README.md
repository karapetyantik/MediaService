# MediaService — подробная документация (все файлы)

Микросервис управления медиафайлами: выдаёт presigned-URL для прямой загрузки в MinIO/S3, подтверждает успешную загрузку, дедуплицирует одинаковые файлы по контент-хешу, инициирует фоновую обработку изображений (`ImageProxyService`) и предоставляет gRPC-метод верификации файла для `ChatService`. Хранилище метаданных — PostgreSQL через Prisma.

---

## 1. Дерево модуля

```
src/
├── main.ts
├── app.module.ts / app.controller.ts / app.service.ts
├── common/
│   ├── auth/    (jwt.strategy.ts, jwt-auth.guard.ts, auth.module.ts)
│   └── prisma/  (prisma.module.ts, prisma.service.ts)
├── proto/media.proto        — контракт MediaInternal (сервер здесь)
└── modules/
    ├── dto/ (request-upload.dto.ts, confirm-upload.dto.ts)
    ├── s3/  (s3.module.ts, s3.service.ts)
    └── media/
        ├── media.module.ts
        ├── media.controller.ts          — REST /media/*
        ├── media.service.ts
        ├── media-events.controller.ts   — событие image.processed
        └── grpc-media/grpc-media.controller.ts  — сервер MediaInternal
```

---

## 2. `main.ts` — точка входа

Поднимает три транспорта:
1. **HTTP** — `PORT`, по умолчанию `3004`.
2. **gRPC-сервер**: `package: 'media'`, `protoPath: dist/proto/media.proto`, слушает `0.0.0.0:5002` — реализует контракт `MediaInternal` (`VerifyMedia`), к которому обращается `ChatService` (через `MediaClientService`).
3. **RabbitMQ-консьюмер**: очередь `media_processing_events` (durable) — слушает событие `image.processed` от `ImageProxyService`.

## 3. `app.module.ts`

Импортирует `ConfigModule` (global), `PrismaModule`, `S3Module`, `MediaModule`, `AuthModule`.

## 4. `common/auth/`, `common/prisma/`

Идентичны по структуре аналогичным модулям в других сервисах (`JwtStrategy` с общим `JWT_SECRET`, `PrismaService` на `PrismaPg`-адаптере).

## 5. `modules/s3/s3.service.ts` — обёртка над MinIO/S3

Отличается от версии в `ImageProxyService` дополнительным полем `etag` в `checkObjectExists`:

| Метод | Отличие от `ImageProxyService` |
|---|---|
| `getUploadUrl(objectKey, mimeType)` | идентичен, TTL 300 сек — **используется** здесь (в отличие от `ImageProxyService`) |
| `checkObjectExists(objectKey)` | возвращает `{ exists, sizeBytes, etag }` — `etag` очищен от кавычек (`result.ETag.replace(/"/g, '')`), используется для дедупликации файлов (см. `confirmUpload`) |
| `getDownloadUrl(objectKey)` | TTL 3600 сек, используется активно |
| `downloadObject` / `uploadBuffer` | **отсутствуют** в этой версии `S3Service` — здесь сервис только выдаёт presigned URL и проверяет метаданные объекта, сам не читает/не пишет содержимое файлов (в отличие от `ImageProxyService`, который скачивает и заливает буферы) |

Импортирует дополнительно `PutObjectAclCommand` из AWS SDK, но нигде его не использует в предоставленном коде — неиспользуемый импорт.

## 6. `modules/dto/` — валидация запросов

### `RequestUploadDto`
```ts
class RequestUploadDto {
  @IsString() @MaxLength(255) fileName!: string;
  @IsOptional() @IsIn(['attachment', 'avatar']) purpose?: 'attachment' | 'avatar';
  @IsIn(['image/jpeg','image/png','image/gif','image/webp','video/mp4','application/pdf','application/octet-stream']) mimeType!: string;
  @IsOptional() @IsInt() @Min(1) sizeBytes?: number;
}
```
- `mimeType` ограничен явным белым списком — попытка загрузить файл с иным MIME-типом будет отклонена ещё до получения presigned URL.
- `sizeBytes` опционален и не обязателен на этапе запроса URL (клиент может не знать точный размер заранее); фактический размер перепроверяется позже через `checkObjectExists` в `confirmUpload`.

### `ConfirmUploadDto`
```ts
class ConfirmUploadDto {
  @IsOptional() @IsInt() @Min(0) cropX?: number;
  @IsOptional() @IsInt() @Min(0) cropY?: number;
  @IsOptional() @IsInt() @Min(1) cropSize?: number;
}
```
Параметры обрезки для аватара — все опциональны на уровне DTO, обязательность для `purpose: 'avatar'` проверяется вручную в сервисе (см. `confirmUpload`).

## 7. `modules/media/media.module.ts`

Импортирует `PrismaModule`, `S3Module`. Регистрирует **два независимых** RabbitMQ-клиента:
- `RABBITMQ_SERVICE` → очередь `media_events` (публикация `file.uploaded` для `ImageProxyService`);
- `USER_EVENTS_SERVICE` → очередь `user_events` (публикация `avatar.updated` для `UserService`).

Controllers: `MediaController` (REST), `MediaEventsController` (событие `image.processed`), `GrpcMediaController` (gRPC-сервер). Providers: `MediaService`.

## 8. `modules/media/media.controller.ts` — REST `/media/*`

Весь контроллер под `JwtAuthGuard`.

| Метод | HTTP | Роут | Делегирует |
|---|---|---|---|
| `requestUpload` | POST | `/media/upload-url` | `mediaService.requestUpload(userId, dto)` |
| `confirm` | POST | `/media/:mediaId/confirm` | `mediaService.confirmUpload(mediaId, userId, dto)` |

## 9. `modules/media/media-events.controller.ts` — обработчик `image.processed`

```ts
@EventPattern('image.processed')
async handleImageProcessed(@Payload() data: { mediaId: string; variants: Record<string, string> }) {
  await this.mediaService.saveVariants(data.mediaId, data.variants);
}
```
Приходит из `ImageProxyService` (см. соответствующую документацию) после генерации `thumbnail`/`medium`/`avatar`/`placeholder`.

## 10. `modules/media/grpc-media/grpc-media.controller.ts` — сервер `MediaInternal`

```ts
@GrpcMethod('MediaInternal', 'VerifyMedia')
async verifyMedia(data: { mediaId: string; uploaderId: string }) {
  const file = await this.prisma.mediaFile.findUnique({ where: { id: data.mediaId } });
  if (!file || file.uploaderId !== data.uploaderId || file.status !== 'confirmed') {
    return { valid: false, url: '', mimeType: '' };
  }
  const url = await this.s3Service.getDownloadUrl(file.objectKey);
  const variants = file.variants as { placeholder?: string } | null;
  return { valid: true, url, mimeType: file.mimeType, placeholder: variants?.placeholder ?? '' };
}
```

**Три условия валидности** вложения, проверяемые для `ChatService` перед отправкой сообщения:
1. Файл существует в БД.
2. `uploaderId` файла совпадает с тем, кто пытается его прикрепить (нельзя прикрепить чужой файл).
3. Статус файла — `'confirmed'` (загрузка была подтверждена через `confirmUpload`, а не осталась в состоянии `'pending'`).

При невалидности возвращает `{ valid: false, url: '', mimeType: '' }` без `placeholder` в этой ветке (поле просто отсутствует в объекте ответа — если `.proto`-контракт ожидает поле `placeholder` всегда, на стороне клиента (`ChatService`) оно в этом случае, скорее всего, придёт как `undefined`/значение по умолчанию для gRPC).

Каждый вызов генерирует **новый** presigned download-URL (TTL 3600 сек) — то есть URL не кешируется и не переиспользуется между запросами, при частой отправке сообщений с одним и тем же вложением (например, при пересылке) URL будет каждый раз новым, хотя и рабочим.

## 11. `modules/media/media.service.ts` — бизнес-логика

**Зависимости:** `PrismaService`, `S3Service`, `ClientProxy('RABBITMQ_SERVICE')`, `ClientProxy('USER_EVENTS_SERVICE')`.

### 11.1. `requestUpload(uploaderId, dto)`
1. Генерирует `mediaId` (`randomUUID()`).
2. Формирует `objectKey` как `` `${uploaderId}/${mediaId}${extname(dto.fileName)}` `` — файлы физически организованы по префиксу `uploaderId/` внутри бакета, сохраняя оригинальное расширение.
3. Создаёт запись `MediaFile` со статусом `'pending'`, `purpose: dto.purpose ?? 'attachment'`.
4. Запрашивает presigned upload URL (`s3Service.getUploadUrl`) и возвращает `{ mediaId, uploadUrl, objectKey }` клиенту, который затем должен загрузить файл **напрямую в S3/MinIO**, минуя бэкенд (классический паттерн presigned upload — снижает нагрузку на сам сервис).

### 11.2. `confirmUpload(mediaId, uploaderId, dto)`
1. Находит файл по `mediaId` — `NotFoundException`, если нет.
2. Проверяет, что `file.uploaderId === uploaderId` — иначе `BadRequestException('Это не ваш файл')`.
3. Если `purpose === 'avatar'`, требует все три параметра обрезки (`cropX`, `cropY`, `cropSize`) — иначе `BadRequestException`.
4. Проверяет фактическое наличие объекта в S3 (`checkObjectExists`) — если файл ещё не загружен клиентом, `BadRequestException('Файл ещё не загружен в хранилище')`.
5. **Дедупликация по контент-хешу:** если у объекта есть `etag`, ищет **другой** уже подтверждённый файл (`status: 'confirmed'`) того же `uploaderId` с тем же `contentHash`. Если найден:
   - удаляет **только что созданную** запись `mediaId` из БД (`prisma.mediaFile.delete`);
   - **не удаляет** сам объект из S3/MinIO — соответствующий вызов закомментирован (`// await this.s3Service.deleteObject(...)`), с пометкой, что метод удаления в `S3Service` не реализован — то есть физический дубликат данных **остаётся в хранилище навсегда**, только запись в БД для него не создаётся;
   - возвращает данные **существующего** файла (`{ mediaId: existing.id, url, status: 'confirmed', reused: true }`) — клиент получает `mediaId` уже ранее загруженного идентичного файла, а не только что запрошенного.
6. Если дубликат не найден — обновляет запись: `status: 'confirmed'`, `confirmedAt`, `sizeBytes` (перезаписывается фактическим значением из S3, а не из DTO запроса), `contentHash: etag`, параметры обрезки.
7. Публикует `rabbitClient.emit('file.uploaded', { mediaId, uploaderId, url, mimeType, fileName, sizeBytes, objectKey, purpose, crop })` в очередь `media_events` — это событие слушает `ImageProxyService`. Поле `crop` формируется только для `purpose === 'avatar'`, иначе `null`.
8. Возвращает `{ mediaId, url, status }`.

**Замечание (безопасность/логика):** дедупликация выполняется **в рамках одного `uploaderId`** (`where: { uploaderId, contentHash: etag, ... }`) — то есть одинаковый файл, загруженный **разными** пользователями, дедуплицирован не будет: каждый пользователь получит собственную независимую запись и, соответственно, независимый объект в S3 (по факту с разными `objectKey`, так как ключ включает `uploaderId`). Это разумное решение с точки зрения приватности (нельзя случайно «спалить» чужой файл через угадывание хеша), но также означает, что реальной экономии места при загрузке одного и того же публичного изображения разными пользователями не происходит.

### 11.3. `saveVariants(mediaId, variants)`
1. Обновляет `MediaFile.variants` результатом от `ImageProxyService` (JSON-поле).
2. Если `file.purpose === 'avatar'` и `variants.avatar` присутствует:
   - формирует `avatarUrl` как **захардкоженную** строку `` `http://localhost:9000/chat-alpha-avatars/${variants.avatar}` `` (см. замечания — не читается из конфигурации, ссылается на `localhost`, что не будет работать за пределами локальной машины разработчика);
   - публикует `userEventsClient.emit('avatar.updated', { userId: file.uploaderId, avatarUrl })` в очередь `user_events`, которую слушает `UserService`.

---

## 12. Модель данных (реконструкция)

**`MediaFile`**
| Поле | Комментарий |
|---|---|
| `id` | PK, `mediaId` (UUID) |
| `uploaderId` | владелец файла |
| `objectKey` | путь в S3/MinIO |
| `fileName` | оригинальное имя файла |
| `mimeType` | из белого списка `RequestUploadDto` |
| `sizeBytes` | перезаписывается фактическим значением при подтверждении |
| `status` | `'pending'` → `'confirmed'` |
| `purpose` | `'attachment'` \| `'avatar'` |
| `confirmedAt` | дата подтверждения |
| `contentHash` | ETag объекта в S3 — используется для дедупликации в рамках одного `uploaderId` |
| `cropX`, `cropY`, `cropSize` | параметры обрезки для `purpose: 'avatar'` |
| `variants` | JSON — заполняется из события `image.processed` (`thumbnail`, `medium`, `avatar`, `placeholder`) |

---

## 13. Интеграции — сводная таблица

| Канал | Направление | Партнёр | Событие/метод |
|---|---|---|---|
| gRPC-сервер `MediaInternal` (порт 5002) | предоставляет | `ChatService` | `VerifyMedia` |
| RabbitMQ (`media_events`) | публикует | `ImageProxyService` | `file.uploaded` |
| RabbitMQ (`media_processing_events`) | слушает | `ImageProxyService` | `image.processed` |
| RabbitMQ (`user_events`) | публикует | `UserService` | `avatar.updated` |
| S3/MinIO | presigned URL + метаданные | — | загрузка/скачивание файлов пользователем напрямую |

---

## 14. Сводные замечания

1. **Захардкоженный URL аватара** (`http://localhost:9000/chat-alpha-avatars/...`) в `saveVariants` — не читается из конфигурации (`MINIO_ENDPOINT`/`MINIO_PORT`/бакет), сломается вне локальной разработки. Стоит формировать через `S3Service.getDownloadUrl` (presigned, с TTL) либо через настраиваемый публичный CDN/base-URL, а не через захардкоженную строку.
2. **Удаление дубликата не реализовано в `S3Service`** — закомментированный вызов `deleteObject` означает, что при срабатывании дедупликации по контент-хешу физический объект в хранилище остаётся «висеть» бесхозным навсегда (запись в БД для него не создаётся, поэтому в будущем на него никто не сошлётся, но место в MinIO не освобождается).
3. **Дедупликация не работает между разными пользователями** — по замыслу (приватность), но стоит явно задокументировать это поведение, если ожидается экономия места при повторной загрузке одного и того же публичного файла разными людьми.
4. **Неиспользуемый импорт `PutObjectAclCommand`** в `s3.service.ts`.
5. **`GrpcMediaController.verifyMedia` не возвращает `placeholder` в ветке `valid: false`** — при обращении к полю на стороне gRPC-клиента (`ChatService`) оно, вероятно, получит значение по умолчанию для типа `string` в proto (пустая строка) — не критично, но стоит для консистентности всегда возвращать полный набор полей контракта.
6. **`sizeBytes`, переданный клиентом в `RequestUploadDto`, используется только как первичная информация** — при подтверждении (`confirmUpload`) перезаписывается фактическим значением из `HeadObjectCommand`, что корректно с точки зрения доверия к данным (не полагается на клиентские данные о размере).
7. Как и во всех сервисах системы, часть сообщений об ошибках — на русском, без единого слоя интернационализации.
