/** Fixed-window token bucket: `capacity` allowances per `windowMs` per key. In-memory, single-process. */
export class TokenBucket {
  private hits = new Map<string, { windowStart: number; count: number }>();

  constructor(private capacity: number, private windowMs: number) {}

  allow(key: string, now: Date): boolean {
    const t = now.getTime();
    const e = this.hits.get(key);
    if (!e || t - e.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      return true;
    }
    if (e.count >= this.capacity) return false;
    e.count += 1;
    return true;
  }

  retryAfterSeconds(key: string, now: Date): number {
    const e = this.hits.get(key);
    if (!e) return 0;
    return Math.max(1, Math.ceil((e.windowStart + this.windowMs - now.getTime()) / 1000));
  }
}
