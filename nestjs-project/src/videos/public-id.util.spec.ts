import { generatePublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('generatePublicId', () => {
  it('should produce an 11-character URL-safe id', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should not repeat across a large sample', () => {
    const sample = new Set(
      Array.from({ length: 10_000 }, () => generatePublicId()),
    );

    expect(sample.size).toBe(10_000);
  });
});
