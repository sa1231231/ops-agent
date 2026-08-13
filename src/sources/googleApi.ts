/**
 * Thin HTTP layer over Google's REST APIs.
 *
 * Handles the two things every caller would otherwise repeat: retrying the
 * failures that are worth retrying, and distinguishing "this account is broken"
 * from "Google is busy". That distinction matters because a broken account must
 * be recorded and skipped, while a busy API must not cost us the account's data
 * for the day.
 */

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }

  /** 401/403 on a token means the grant is gone; a human must reconnect. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.reason === "authError";
  }

  /** Gmail returns 404 when a history cursor has aged out. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;

function retryable(status: number): boolean {
  return status === 429 || status === 403 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GoogleErrorBody {
  error?: {
    message?: string;
    errors?: Array<{ reason?: string }>;
    status?: string;
  };
}

export async function googleFetch<T>(
  url: string,
  accessToken: string,
): Promise<T> {
  let lastError: GoogleApiError | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.ok) return (await res.json()) as T;

    const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
    const message = body.error?.message ?? res.statusText;

    lastError = new GoogleApiError(res.status, reason, `${res.status} ${reason}: ${message}`);

    // A 403 is ambiguous: rateLimitExceeded and userRateLimitExceeded are
    // transient, but insufficientPermissions or accessNotConfigured are
    // permanent and retrying just wastes the sync window.
    const transient403 =
      res.status === 403 && /rateLimit|quotaExceeded|backendError/i.test(reason);

    if (!retryable(res.status) || (res.status === 403 && !transient403)) {
      throw lastError;
    }

    if (attempt === MAX_ATTEMPTS - 1) break;

    // Exponential backoff with jitter, so 15 accounts retrying at once don't
    // resynchronize into a thundering herd.
    const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 250;
    await sleep(delay);
  }

  throw lastError ?? new GoogleApiError(0, "unknown", "Request failed");
}

/**
 * Runs tasks with bounded concurrency.
 *
 * Gmail metadata reads are one HTTP call per message, so a 500-message cold
 * start is 500 calls. Unbounded parallelism trips per-user rate limits; serial
 * execution takes minutes. Ten at a time sits comfortably under the quota.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}
