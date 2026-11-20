import type { VideoMetadata } from '../videos/entities/video.entity';

/** Subset of `ffprobe -print_format json -show_format -show_streams`. */
export interface FfprobeOutput {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "30000/1001" → 29.97; "0/0" or missing → null. */
function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!den || !Number.isFinite(num) || !Number.isFinite(den) || num === 0) {
    return null;
  }
  return Math.round((num / den) * 100) / 100;
}

/**
 * Extracts duration + metadata (phase-03-videos/TD-05). Returns `null` when
 * the source has no video stream — a permanent failure for the worker.
 */
export function parseProbeOutput(output: FfprobeOutput): ProbeResult | null {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) return null;
  const audio = streams.find((s) => s.codec_type === 'audio');

  return {
    durationSeconds: toNumber(output.format?.duration),
    metadata: {
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name ?? 'unknown',
      audioCodec: audio?.codec_name ?? null,
      formatName: output.format?.format_name ?? 'unknown',
      bitRate: toNumber(output.format?.bit_rate),
      frameRate:
        parseFrameRate(video.avg_frame_rate) ??
        parseFrameRate(video.r_frame_rate),
    },
  };
}
