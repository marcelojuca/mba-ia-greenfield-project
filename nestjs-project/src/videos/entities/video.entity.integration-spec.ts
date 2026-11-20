import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `owner-${randomUUID()}@example.com`,
      password: 'hash',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: `owner_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Partial<Video> {
    const id = randomUUID();
    return {
      id,
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'My trip',
      original_filename: 'my-trip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/source`,
      ...overrides,
    };
  }

  it('persists the code-assigned id and defaults status to draft', async () => {
    const input = buildVideo();

    await videos.insert(input);

    const saved = await videos.findOneByOrFail({ id: input.id });
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.upload_id).toBeNull();
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.created_at).toBeInstanceOf(Date);
  });

  it('rejects a duplicate public_id with a unique violation', async () => {
    const publicId = generatePublicId();
    await videos.insert(buildVideo({ public_id: publicId }));

    await expect(
      videos.insert(buildVideo({ public_id: publicId })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('round-trips a 10 GiB size_bytes as a number', async () => {
    const input = buildVideo({ size_bytes: 10737418240 });

    await videos.insert(input);

    const saved = await videos.findOneByOrFail({ id: input.id });
    expect(saved.size_bytes).toBe(10737418240);
  });

  it('rejects a status outside the enum', async () => {
    await expect(
      videos.insert(buildVideo({ status: 'published' as VideoStatus })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('stores metadata as jsonb', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: null,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitRate: 5_000_000,
      frameRate: 29.97,
    };
    const input = buildVideo({ metadata });

    await videos.insert(input);

    const saved = await videos.findOneByOrFail({ id: input.id });
    expect(saved.metadata).toEqual(metadata);
  });

  it('deletes videos when their channel is deleted', async () => {
    const input = buildVideo();
    await videos.insert(input);

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    await expect(videos.findOneBy({ id: input.id })).resolves.toBeNull();
  });

  it('loads the owning channel through the relation', async () => {
    const input = buildVideo();
    await videos.insert(input);

    const saved = await videos.findOneOrFail({
      where: { id: input.id },
      relations: { channel: true },
    });

    expect(saved.channel.id).toBe(channel.id);
  });
});
