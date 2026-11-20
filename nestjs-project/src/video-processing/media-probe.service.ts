import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  type FfprobeOutput,
  parseProbeOutput,
  type ProbeResult,
} from './media-probe.parser';

/** The source is not decodable media — retrying cannot help. */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const THUMBNAIL_WIDTH = 1280;

/**
 * ffmpeg/ffprobe failures caused by the environment (storage/network), worth
 * retrying. Any other failure means the fetched bytes are not decodable media:
 * decode errors vary widely by demuxer, so they are classified by exclusion.
 */
const TRANSIENT_ERROR_PATTERNS = [
  /Server returned/i,
  /Connection (refused|reset|timed out)/i,
  /Network is unreachable/i,
  /Temporary failure in name resolution/i,
  /Failed to resolve hostname/i,
  /End of file while reading/i,
  /I\/O error/i,
];

interface ExecResult {
  stdout: Buffer;
}

/**
 * Thin wrapper over the system ffprobe/ffmpeg binaries (phase-03-videos/TD-05).
 * Sources are read from a URL with HTTP range requests — the file is never
 * downloaded in full.
 */
@Injectable()
export class MediaProbeService {
  /** Returns duration/metadata, or `null` when the source has no video stream. */
  async probe(url: string): Promise<ProbeResult | null> {
    const { stdout } = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      PROBE_TIMEOUT_MS,
    );
    return parseProbeOutput(JSON.parse(stdout.toString()) as FfprobeOutput);
  }

  /** Renders the frame at `atSeconds` as a JPEG, 1280px wide (aspect kept). */
  async extractThumbnail(url: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMBNAIL_WIDTH}:-2`,
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      THUMBNAIL_TIMEOUT_MS,
    );
    if (stdout.length === 0) {
      throw new InvalidMediaError(`No frame could be decoded at ${atSeconds}s`);
    }
    return stdout;
  }

  private run(
    binary: string,
    args: string[],
    timeout: number,
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        { encoding: 'buffer', timeout, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout });
            return;
          }
          const detail = stderr.toString().trim() || error.message;
          const transient =
            error.killed || // timeout
            TRANSIENT_ERROR_PATTERNS.some((p) => p.test(detail));
          reject(
            transient
              ? new Error(`${binary} failed: ${detail}`)
              : new InvalidMediaError(`${binary}: ${detail}`),
          );
        },
      );
    });
  }
}
