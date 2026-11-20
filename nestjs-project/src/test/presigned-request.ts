import * as http from 'node:http';
import * as https from 'node:https';

export interface PresignedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface PresignedRequestOptions {
  method?: 'GET' | 'PUT' | 'HEAD';
  body?: Buffer;
  headers?: Record<string, string>;
}

/**
 * Calls a presigned storage URL from inside the Compose network.
 *
 * Client-facing URLs are signed for S3_PUBLIC_ENDPOINT (e.g. localhost:9000),
 * which is not reachable from a container. SigV4 signs the Host header, so the
 * request is sent to S3_ENDPOINT (e.g. minio:9000) while keeping the original
 * Host — exactly what MinIO would receive from a browser on the host machine.
 */
export async function presignedRequest(
  presignedUrl: string,
  options: PresignedRequestOptions = {},
): Promise<PresignedResponse> {
  const signed = new URL(presignedUrl);
  const target = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: options.method ?? 'GET',
        path: `${signed.pathname}${signed.search}`,
        headers: {
          ...options.headers,
          host: signed.host,
          ...(options.body && { 'content-length': options.body.length }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Uploads `file` the way a client would: slice `partSize` bytes per part and
 * PUT each slice to its presigned URL. Returns the ETags of the parts.
 */
export async function uploadFileToParts(
  parts: { partNumber: number; url: string }[],
  partSize: number,
  file: Buffer,
): Promise<string[]> {
  const etags: string[] = [];
  for (const part of parts) {
    const start = (part.partNumber - 1) * partSize;
    const res = await presignedRequest(part.url, {
      method: 'PUT',
      body: file.subarray(start, start + partSize),
    });
    if (res.status !== 200) {
      throw new Error(
        `Part ${part.partNumber} upload failed with ${res.status}: ${res.body.toString()}`,
      );
    }
    etags.push(String(res.headers.etag));
  }
  return etags;
}
