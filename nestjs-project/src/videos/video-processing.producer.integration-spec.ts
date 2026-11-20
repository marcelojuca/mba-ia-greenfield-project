import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos.constants';

describe('VideoProcessingProducer (integration — Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<VideoProcessingJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();
    await module.init();
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('enqueues a process-video job with the video id and retry policy', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const [job] = await queue.getJobs(['waiting']);
    expect(job.name).toBe(PROCESS_VIDEO_JOB);
    expect(job.id).toBe(videoId);
    expect(job.data).toEqual({ videoId });
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('collapses repeated enqueues of the same video into one job', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    await expect(queue.getJobCounts('waiting')).resolves.toEqual({
      waiting: 1,
    });
  });

  it('keeps test jobs under the test-only Redis prefix', () => {
    expect(queue.opts.prefix).toBe('streamtube-test');
  });
});
