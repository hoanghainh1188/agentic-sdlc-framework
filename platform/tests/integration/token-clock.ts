// The issue time of the API tokens a test seeds. `api_tokens.created_at` is the database's
// `now()` (the real clock), and the CHECK `expires_at > created_at` refuses a token whose expiry,
// computed from a fixed test clock (NOW, T0 …) plus its lifetime, is already past: such a test
// starts failing on a known day. The api's own clock stays the test clock, so its checks stay
// deterministic: a token issued now and valid for days is valid at every fixed clock before it.

/** The current second, as the issue time of a seeded API token (never a fixed test clock). */
export function tokenIssuedAt(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}
