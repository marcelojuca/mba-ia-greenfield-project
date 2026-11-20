import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoFixtureOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  withAudio?: boolean;
}

/**
 * Generates a real H.264 MP4 with ffmpeg's synthetic sources (testsrc + sine).
 * `faststart` keeps the moov atom at the front, like web-ready uploads.
 */
export async function createVideoFixture(
  options: VideoFixtureOptions = {},
): Promise<Buffer> {
  const {
    durationSeconds = 3,
    width = 320,
    height = 240,
    withAudio = true,
  } = options;
  const out = join(tmpdir(), `fixture-${randomUUID()}.mp4`);
  const args = [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=25`,
    ...(withAudio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`]
      : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-shortest'] : []),
    '-movflags',
    '+faststart',
    out,
  ];
  try {
    await execFileAsync('ffmpeg', args);
    return await readFile(out);
  } finally {
    await rm(out, { force: true });
  }
}

/** Generates an audio-only M4A (decodable media without a video stream). */
export async function createAudioOnlyFixture(): Promise<Buffer> {
  const out = join(tmpdir(), `fixture-${randomUUID()}.m4a`);
  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'aac',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(out, { force: true });
  }
}

/**
 * Plain text bytes: deterministically rejected by every demuxer ("Invalid data
 * found when processing input"). Random bytes are not used because ffprobe
 * sometimes sniffs them as MP3.
 */
export function createCorruptFixture(): Buffer {
  return Buffer.from('this is definitely not a video file\n'.repeat(100));
}
