/**
 * The complete set of Google OAuth scopes this system will ever request.
 *
 * ops-agent is read-only. It never sends, moves, deletes, labels, or modifies
 * anything in any connected account. Adding a write scope here — gmail.send,
 * gmail.modify, any calendar write — breaks that guarantee for all ~15 accounts
 * at once, silently, on their next token refresh.
 *
 * This constant is the single place scopes are defined. Nothing else in the
 * codebase should contain a googleapis.com/auth/ URL.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
] as const;

export const SCOPE_STRING = SCOPES.join(" ");

/** Guards against a token issued with scopes we did not ask for. */
export function hasOnlyExpectedScopes(granted: string): boolean {
  const allowed = new Set<string>(SCOPES);
  return granted
    .split(/\s+/)
    .filter(Boolean)
    .every((scope) => allowed.has(scope));
}
