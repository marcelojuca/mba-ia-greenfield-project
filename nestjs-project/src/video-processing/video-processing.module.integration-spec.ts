import { createVideoTestingModule } from '../test/video-test-module';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingProcessor } from './video-processing.processor';

describe('VideoProcessingModule (integration)', () => {
  it('should compile and register the queue processor', async () => {
    const module = await createVideoTestingModule([VideoProcessingModule]);

    const processor = module.get(VideoProcessingProcessor);
    expect(processor.worker.name).toBe('video-processing');
    await module.close();
  }, 30000);
});
