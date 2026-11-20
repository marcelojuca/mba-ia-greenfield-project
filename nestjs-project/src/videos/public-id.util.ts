import { randomBytes } from 'node:crypto';

/** Length of a video public id: 8 random bytes in base64url (phase-03-videos/TD-06). */
export const PUBLIC_ID_LENGTH = 11;

/** Generates the unique, URL-safe, non-sequential id used in a video's URL. */
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}
