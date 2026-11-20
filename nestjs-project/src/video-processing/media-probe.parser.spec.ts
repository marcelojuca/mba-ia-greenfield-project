import { parseProbeOutput } from './media-probe.parser';

describe('parseProbeOutput', () => {
  it('should extract duration and metadata from a video with audio', () => {
    const result = parseProbeOutput({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30000/1001',
        },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '312.480000',
        bit_rate: '5000000',
      },
    });

    expect(result).toEqual({
      durationSeconds: 312.48,
      metadata: {
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitRate: 5000000,
        frameRate: 29.97,
      },
    });
  });

  it('should set audioCodec to null for a video-only file', () => {
    const result = parseProbeOutput({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'vp9',
          width: 640,
          height: 360,
          avg_frame_rate: '25/1',
        },
      ],
      format: { format_name: 'matroska,webm', duration: '10.0' },
    });

    expect(result?.metadata.audioCodec).toBeNull();
    expect(result?.metadata.frameRate).toBe(25);
  });

  it('should return null when there is no video stream', () => {
    expect(
      parseProbeOutput({
        streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
        format: { format_name: 'mp3', duration: '120' },
      }),
    ).toBeNull();
  });

  it('should tolerate missing optional fields', () => {
    const result = parseProbeOutput({
      streams: [
        {
          codec_type: 'video',
          width: 320,
          height: 240,
          avg_frame_rate: '0/0',
          r_frame_rate: '24/1',
        },
      ],
    });

    expect(result).toEqual({
      durationSeconds: null,
      metadata: {
        width: 320,
        height: 240,
        videoCodec: 'unknown',
        audioCodec: null,
        formatName: 'unknown',
        bitRate: null,
        frameRate: 24,
      },
    });
  });
});
