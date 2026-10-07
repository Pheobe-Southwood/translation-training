/**
 * Minimal FIFO semaphore used to bound how many DeepSeek requests are in flight.
 *
 * Pipelined multi-round play lets a fast player run several rounds ahead, which can
 * enqueue many (round, segment) grading batches at once. Without a gate those bursts
 * ride straight into the 90s request timeout and the provider's rate limits.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('Semaphore requires maxConcurrent >= 1');
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async operation with exponential backoff. `attempts` counts the initial
 * try, so `attempts = 3` means at most three calls in total.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 800;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) {
        console.warn(
          `[retry] ${options.label ?? 'task'} attempt ${attempt}/${attempts} failed: ${message} — retrying`
        );
        await delay(baseDelayMs * Math.pow(2, attempt - 1));
      } else {
        console.error(`[retry] ${options.label ?? 'task'} exhausted ${attempts} attempts: ${message}`);
      }
    }
  }

  throw lastError;
}
