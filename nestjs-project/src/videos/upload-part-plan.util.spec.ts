import { planUploadParts } from './upload-part-plan.util';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

describe('planUploadParts', () => {
  it('should split 10 GiB into 103 parts of 100 MiB', () => {
    expect(planUploadParts(10 * GIB, 100 * MIB)).toEqual({
      partSize: 100 * MIB,
      partCount: 103,
    });
  });

  it('should use a single part for files smaller than the part size', () => {
    expect(planUploadParts(1024, 100 * MIB)).toEqual({
      partSize: 100 * MIB,
      partCount: 1,
    });
  });

  it('should produce an exact part count when the size is a multiple', () => {
    expect(planUploadParts(300 * MIB, 100 * MIB).partCount).toBe(3);
  });

  it('should raise the part size to stay within 10,000 parts', () => {
    const plan = planUploadParts(2 * TIB, 100 * MIB);

    expect(plan.partCount).toBeLessThanOrEqual(10_000);
    expect(plan.partSize).toBe(Math.ceil((2 * TIB) / 10_000));
  });
});
