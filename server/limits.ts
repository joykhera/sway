export type StreamSlots = {
  tryAcquire(): boolean;
  release(): void;
  readonly inUse: number;
};

export function createStreamSlots(max: number): StreamSlots {
  let inUse = 0;
  return {
    tryAcquire() {
      if (inUse >= max) return false;
      inUse++;
      return true;
    },
    release() {
      if (inUse > 0) inUse--;
    },
    get inUse() {
      return inUse;
    },
  };
}
