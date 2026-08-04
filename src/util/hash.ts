import { createHash } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable fingerprint for a generation request; used for idempotency. */
export function fingerprint(parts: Array<string | number>): string {
  return sha256(parts.map((part) => String(part).trim().toLowerCase()).join(' ')).slice(0, 32);
}

/** Deterministic 32-bit hash (FNV-1a), used to seed the offline model. */
export function seedFrom(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG so offline generation is reproducible. */
export function createRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}
