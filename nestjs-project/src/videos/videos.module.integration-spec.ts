import { createVideoTestingModule } from '../test/video-test-module';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

describe('VideosModule (integration)', () => {
  it('should compile with its entity, storage, channels and queue wiring', async () => {
    const module = await createVideoTestingModule([VideosModule]);

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    await module.close();
  }, 30000);
});
