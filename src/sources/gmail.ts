import {
  COLD_START_DAYS,
  MAX_INBOX_MESSAGES_PER_ACCOUNT,
  MAX_SENT_MESSAGES_PER_ACCOUNT,
  SENT_GRAPH_DAYS,
} from "../config.js";
import { GoogleApiError, googleFetch, mapWithConcurrency } from "./googleApi.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Headers we ask for. Bodies are never requested — subject and snippet only. */
const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "List-Unsubscribe",
  "Precedence",
  "Auto-Submitted",
] as const;

const CONCURRENCY = 10;

/**
 * Tabs that never contain something he needs to act on.
 *
 * Excluded at fetch time rather than demoted at ranking time: it cuts the API
 * calls, the stored rows, and the noise in one move. Updates and Forums are
 * deliberately *not* excluded — Updates carries flight changes, invoices, and
 * legal notices, which are exactly the kind of thing a morning brief should
 * surface.
 *
 * The tradeoff to know about: Gmail's categorizer is occasionally wrong, and a
 * real message miscategorized as Promotions will never be seen at all, since
 * scoring cannot rescue a message that was never fetched.
 */
const EXCLUDED_CATEGORIES = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"] as const;

/** Never wanted anywhere, inbound or outbound. */
const ALWAYS_EXCLUDED = ["SPAM", "TRASH"] as const;

/** Query fragment for the list-based paths, so excluded mail is never fetched. */
const INBOX_FILTER = "-in:chats -category:promotions -category:social";

function hasAny(message: NormalizedMessage, labels: readonly string[]): boolean {
  return message.labels.some((label) => labels.includes(label));
}

export interface NormalizedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string | null;
  snippet: string | null;
  sentAt: Date | null;
  direction: "inbound" | "outbound";
  hasListUnsubscribe: boolean;
  isAutomated: boolean;
  labels: string[];
}

interface RawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

// --- header parsing ---------------------------------------------------------

function headerMap(raw: RawMessage): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of raw.payload?.headers ?? []) {
    // Header names are case-insensitive; Gmail's casing is not guaranteed.
    map.set(h.name.toLowerCase(), h.value);
  }
  return map;
}

/**
 * Splits an address header on commas that are not inside quotes or angle
 * brackets — `"Doe, Jane" <jane@x.com>, bob@y.com` is two addresses, not three.
 */
function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "<") inAngle = true;
    else if (char === ">") inAngle = false;

    if (char === "," && !inQuotes && !inAngle) {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseAddress(value: string): { email: string | null; name: string | null } {
  const angle = value.match(/<([^>]+)>/);
  const email = (angle?.[1] ?? value).trim().toLowerCase();

  let name = angle ? value.slice(0, value.indexOf("<")).trim() : "";
  name = name.replace(/^"(.*)"$/, "$1").trim();

  return {
    email: email.includes("@") ? email : null,
    name: name || null,
  };
}

function emailsFrom(header: string | undefined): string[] {
  if (!header) return [];
  const seen = new Set<string>();
  for (const part of splitAddresses(header)) {
    const { email } = parseAddress(part);
    if (email) seen.add(email);
  }
  return [...seen];
}

const AUTOMATED_LOCALPART =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer[-_.]?daemon|postmaster|bounces?|auto[-_.]?reply|support@|alerts?)/i;

export function normalizeMessage(raw: RawMessage): NormalizedMessage {
  const headers = headerMap(raw);
  const labels = raw.labelIds ?? [];

  const from = parseAddress(headers.get("from") ?? "");
  const hasListUnsubscribe = headers.has("list-unsubscribe");
  const precedence = (headers.get("precedence") ?? "").toLowerCase();
  const autoSubmitted = (headers.get("auto-submitted") ?? "").toLowerCase();

  const localPart = from.email?.split("@")[0] ?? "";
  const isAutomated =
    hasListUnsubscribe ||
    /^(bulk|list|junk)$/.test(precedence) ||
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    AUTOMATED_LOCALPART.test(localPart) ||
    labels.includes("CATEGORY_PROMOTIONS") ||
    labels.includes("CATEGORY_SOCIAL");

  return {
    gmailMessageId: raw.id,
    gmailThreadId: raw.threadId,
    fromEmail: from.email,
    fromName: from.name,
    toEmails: emailsFrom(headers.get("to")),
    ccEmails: emailsFrom(headers.get("cc")),
    subject: headers.get("subject") ?? null,
    snippet: raw.snippet ?? null,
    // internalDate is Gmail's own receive timestamp — more reliable than the
    // Date header, which senders routinely get wrong or forge.
    sentAt: raw.internalDate ? new Date(Number(raw.internalDate)) : null,
    direction: labels.includes("SENT") ? "outbound" : "inbound",
    hasListUnsubscribe,
    isAutomated,
    labels,
  };
}

// --- API calls --------------------------------------------------------------

interface ListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

/** Paginates messages.list, stopping at `cap`. Never runs unbounded. */
export async function listMessageIds(
  accessToken: string,
  query: string,
  cap: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(500, cap - ids.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const page = await googleFetch<ListResponse>(
      `${BASE}/messages?${params}`,
      accessToken,
    );

    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < cap);

  return ids.slice(0, cap);
}

async function fetchMetadata(
  accessToken: string,
  id: string,
): Promise<RawMessage> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of METADATA_HEADERS) params.append("metadataHeaders", h);
  return googleFetch<RawMessage>(`${BASE}/messages/${id}?${params}`, accessToken);
}

async function fetchMany(
  accessToken: string,
  ids: string[],
  { excludeCategories = true }: { excludeCategories?: boolean } = {},
): Promise<NormalizedMessage[]> {
  const raw = await mapWithConcurrency(ids, CONCURRENCY, (id) =>
    fetchMetadata(accessToken, id).catch((err: unknown) => {
      // A single message can vanish between list and get (deleted mid-sync).
      // Losing one message must not fail the account's whole sync.
      if (err instanceof GoogleApiError && err.isNotFound) return null;
      throw err;
    }),
  );

  const messages = raw
    .filter((m): m is RawMessage => m !== null)
    .map(normalizeMessage);

  // Applied here rather than only in the query, because history.list — the
  // incremental path — accepts no query and would otherwise leak promotions
  // back in on every sync after cold start.
  const excluded = excludeCategories
    ? [...ALWAYS_EXCLUDED, ...EXCLUDED_CATEGORIES]
    : ALWAYS_EXCLUDED;

  return messages.filter((m) => !hasAny(m, excluded));
}

/**
 * Cold start: the last 7 days of inbox, capped.
 *
 * COLD_START_DAYS is a hard constant. There are thousands of unread messages in
 * these accounts and none of them are today's problem — widening this window is
 * how the brief becomes an archaeology report.
 */
export async function fetchColdStartInbox(
  accessToken: string,
): Promise<NormalizedMessage[]> {
  const ids = await listMessageIds(
    accessToken,
    `newer_than:${COLD_START_DAYS}d ${INBOX_FILTER}`,
    MAX_INBOX_MESSAGES_PER_ACCOUNT,
  );
  return fetchMany(accessToken, ids);
}

/**
 * Sent metadata for the correspondent graph.
 *
 * This reaches back 90 days, well beyond the 7-day inbox window, and that is
 * deliberate: the never-backfill rule is about not dredging the unread inbox.
 * Knowing who he actually writes to is what separates a real person waiting on
 * a reply from noise, and it works on day one instead of taking weeks to warm up.
 */
export async function fetchSentForGraph(
  accessToken: string,
): Promise<NormalizedMessage[]> {
  const ids = await listMessageIds(
    accessToken,
    `in:sent newer_than:${SENT_GRAPH_DAYS}d`,
    MAX_SENT_MESSAGES_PER_ACCOUNT,
  );
  // Category exclusion is inbound-only. Who he writes to is the signal here,
  // and dropping a sent message because Gmail tagged the thread Promotions
  // would quietly weaken the correspondent graph.
  return fetchMany(accessToken, ids, { excludeCategories: false });
}

export async function fetchProfileHistoryId(
  accessToken: string,
): Promise<string | null> {
  const profile = await googleFetch<{ historyId?: string }>(
    `${BASE}/profile`,
    accessToken,
  );
  return profile.historyId ?? null;
}

interface HistoryResponse {
  history?: Array<{
    messagesAdded?: Array<{ message: { id: string } }>;
    labelsAdded?: Array<{ message: { id: string }; labelIds?: string[] }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
}

/**
 * Labels whose arrival means "look at this message again".
 *
 * Dragging a message out of Promotions into the inbox *adds* CATEGORY_PERSONAL.
 * Without watching for that, a message we dropped at arrival is never
 * reconsidered — which would break the escape hatch that justifies excluding
 * those tabs at fetch time in the first place. Gmail's categoriser is trusted
 * precisely *because* the human can overrule it.
 *
 * Deliberately narrow: `labelsAdded` also fires for stars, user labels and
 * every other bit of mailbox fiddling, and refetching on all of it would spend
 * API calls on nothing.
 */
const RECONSIDER_ON_LABEL = new Set(["CATEGORY_PERSONAL", "IMPORTANT", "INBOX"]);

export interface IncrementalResult {
  messages: NormalizedMessage[];
  newHistoryId: string | null;
  /** True when the cursor aged out and the caller must fall back. */
  expired: boolean;
}

/**
 * Incremental sync from a stored history cursor.
 *
 * Gmail keeps roughly a week of history. If the cursor has aged out it returns
 * 404, and the caller falls back to a *bounded* re-scan — never a full one.
 */
export async function fetchIncremental(
  accessToken: string,
  startHistoryId: string,
): Promise<IncrementalResult> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let newHistoryId: string | null = null;

  try {
    do {
      const params = new URLSearchParams({ startHistoryId });
      // Repeated, not comma-joined: the API takes historyTypes as a multi-value
      // parameter and silently ignores a comma-separated string.
      params.append("historyTypes", "messageAdded");
      params.append("historyTypes", "labelAdded");
      if (pageToken) params.set("pageToken", pageToken);

      const page = await googleFetch<HistoryResponse>(
        `${BASE}/history?${params}`,
        accessToken,
      );

      for (const entry of page.history ?? []) {
        for (const added of entry.messagesAdded ?? []) ids.add(added.message.id);

        // Re-fetch anything he moved into the inbox. The category filter still
        // applies afterwards, so a message that is genuinely still Promotions
        // is dropped again — this only reopens the ones he reclassified.
        for (const labelled of entry.labelsAdded ?? []) {
          if ((labelled.labelIds ?? []).some((id) => RECONSIDER_ON_LABEL.has(id))) {
            ids.add(labelled.message.id);
          }
        }
      }

      newHistoryId = page.historyId ?? newHistoryId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err instanceof GoogleApiError && err.isNotFound) {
      return { messages: [], newHistoryId: null, expired: true };
    }
    throw err;
  }

  return {
    messages: await fetchMany(accessToken, [...ids]),
    newHistoryId,
    expired: false,
  };
}

/** Bounded recovery when the history cursor expires. Never widens to a full scan. */
export async function fetchRecoveryWindow(
  accessToken: string,
): Promise<NormalizedMessage[]> {
  const ids = await listMessageIds(
    accessToken,
    `newer_than:2d ${INBOX_FILTER}`,
    MAX_INBOX_MESSAGES_PER_ACCOUNT,
  );
  return fetchMany(accessToken, ids);
}
