> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real S3-compatible storage via the Docker `minio` service (`compose.yaml`), the same way the queue and the database are real. Production swaps MinIO for S3 through env vars only (phase-03-videos/TD-03). There is no local-filesystem adapter: presigned URLs, multipart uploads, `Range`/`206` and ffprobe-over-HTTP cannot be exercised against a filesystem (phase-03-videos validation ICC-1).

**Setup pattern:**
```typescript
const module = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
    StorageModule,
  ],
}).compile();
await module.init(); // StorageService.onModuleInit ensures the bucket exists
```

**Presigned URLs from inside the container:** client-facing URLs are signed for `S3_PUBLIC_ENDPOINT` (`localhost:9000`), unreachable from a container. Use `src/test/presigned-request.ts` — it sends the request to `S3_ENDPOINT` (`minio:9000`) while preserving the signed `Host` header:

```typescript
const url = await storage.presignUploadPart(key, uploadId, 1);
const res = await presignedRequest(url, { method: 'PUT', body: bytes });
expect(res.status).toBe(200);
```

**Test isolation:**
- Use unique keys per test (`test/${randomUUID()}/...`) and delete them in `afterAll` (`storage.deleteObject(key)`).
- URLs signed with `audience: 'internal'` (worker/ffmpeg) are directly reachable from the container with `fetch`.

---

## Message Queue — Real (Docker)

**Strategy:** Real message broker in Docker. The specific technology is TBD per the architecture diagram (likely BullMQ with Redis or RabbitMQ).

**When the queue technology is chosen, configure:**
- A queue broker service in `compose.yaml` (e.g., Redis for BullMQ, RabbitMQ for AMQP)
- Test isolation: use dedicated test queues or clean queues between tests
- For publisher tests: assert the job is enqueued with correct data
- For consumer tests: submit a job and assert the processing outcome

**Setup pattern (BullMQ example):**
```typescript
// In test module
BullModule.forRoot({
  connection: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

```typescript
describe('VideoService (integration - queue)', () => {
  it('should enqueue a processing job on upload', async () => {
    await videoService.upload(videoData);

    const queue = module.get<Queue>(getQueueToken('video-processing'));
    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual(
      expect.objectContaining({ videoId: expect.any(String) }),
    );
  });
});
```

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
