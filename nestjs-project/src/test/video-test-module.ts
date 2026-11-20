import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { createTestDataSource } from './create-test-data-source';

export const VIDEO_TEST_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

/**
 * Testing module wired to the real Compose services (PostgreSQL, Redis under
 * the test queue prefix, MinIO) for integration tests of video modules.
 */
export async function createVideoTestingModule(
  imports: unknown[],
): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [appConfig, storageConfig, queueConfig],
      }),
      TypeOrmModule.forRoot({
        ...createTestDataSource(VIDEO_TEST_ENTITIES, { synchronize: false })
          .options,
      }),
      QueueModule,
      ...(imports as never[]),
    ],
  }).compile();
  await module.init();
  return module;
}

/** Persists a user + channel pair and returns both ids. */
export async function createChannelOwner(
  dataSource: DataSource,
): Promise<{ userId: string; channelId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const user = await dataSource.getRepository(User).save({
    email: `owner-${suffix}@example.com`,
    password: 'hash',
  });
  const channel = await dataSource.getRepository(Channel).save({
    name: `owner_${suffix}`,
    nickname: `owner_${suffix}`,
    user_id: user.id,
  });
  return { userId: user.id, channelId: channel.id };
}
