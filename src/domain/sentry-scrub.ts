/**
 * What may leave this process in an error report, and what may not.
 *
 * This app is a system of record for contracts and payment history. An
 * exception thrown mid-request carries whatever was in scope: the request body
 * an agent just submitted, the URL a buyer clicked, the environment the process
 * was started with. Sentry's own defaults strip a little of that; they do not
 * know that `BLOB_READ_WRITE_TOKEN` is a live write credential, that a URL with
 * `?token=` in it is a working password reset, or that a Neon connection string
 * is a complete route into the database.
 *
 * So the rule here is deny-first on names, then a second pass over every string
 * value for the shapes that leak regardless of what they are called — because
 * the connection string that ends up in a report is rarely under a key named
 * `DATABASE_URL`. It is in the middle of a Prisma error message.
 *
 * Written as a pure function over a plain object, in `@/domain`, so it can be
 * tested for what it removes and what it leaves without constructing a Sentry
 * client or sending anything anywhere. A scrubber that is only exercised as
 * configuration is a scrubber nobody has ever seen run.
 */

export const REDACTED = '[redacted]'

/**
 * Keys whose *value* is dropped outright, wherever they appear and at whatever
 * depth. Substring matches on purpose: `currentPassword`, `newPasswordHash`,
 * `x-api-key` and `resetToken` all have to be caught, and enumerating spellings
 * is how one gets missed.
 *
 * `token` covers password-reset tokens, CSRF tokens and the blob token.
 * `cookie` covers the session cookie in both the request and response
 * direction. `auth` covers `authorization`, `NEXTAUTH_SECRET` and `AUTH_URL` —
 * the last is not a secret, and losing it is a price worth paying for not
 * having to be right about which `auth*` names are.
 */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|cookie|auth|credential|api[-_]?key|\bdsn\b|connection.?string|database.?url|direct.?url|session/i

/**
 * Shapes that must never appear in a report no matter what key they sit under
 * or whether they sit under a key at all — an exception *message* is a bare
 * string, and it is the likeliest place for any of these to surface.
 */
const VALUE_PATTERNS: { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Any URL carrying `user:password@` — which is every Postgres connection
  // string this app can hold, pooled or direct, plus anything else of that
  // shape that arrives later.
  {
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S+/gi,
    replacement: '[redacted connection string]'
  },
  // A database URL with no credentials in it is still the host and database
  // name of a production system; there is no reason for it to be in a report.
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/\S+/gi,
    replacement: '[redacted connection string]'
  },
  // Vercel Blob's read/write token. It grants writes to the store holding every
  // floor plan and hero image, and it is passed as a bare string.
  { pattern: /vercel_blob_rw_[A-Za-z0-9_-]+/g, replacement: REDACTED },
  // `NAME=value` as it appears in a thrown "missing/invalid env" message.
  {
    pattern:
      /\b(BLOB_READ_WRITE_TOKEN|DATABASE_URL|DIRECT_URL|NEXTAUTH_SECRET|AUTH_SECRET|CRON_SECRET|RESEND_API_KEY|SENTRY_AUTH_TOKEN)\s*[=:]\s*\S+/g,
    replacement: '$1=[redacted]'
  },
  // A live password-reset link. The token is the credential, so the query
  // parameter goes and the path stays — knowing that /reset-password threw is
  // the entire value of the report.
  {
    pattern: /([?&](?:token|reset_?token|access_?token|code|secret)=)[^&\s"']+/gi,
    replacement: '$1[redacted]'
  },
  // A cookie header serialised into a string somewhere other than the headers
  // object — a fetch trace, a log line, a thrown message.
  {
    pattern: /((?:__Secure-|__Host-)?(?:authjs|next-auth)\.[a-z-]*token=)[^;\s"']+/gi,
    replacement: '$1[redacted]'
  },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replacement: '$1 [redacted]' }
]

/**
 * Sentry's event shape, only as far as this module needs to know it.
 *
 * Written as a structural *supertype* of `@sentry/nextjs`'s own `Event`, so a
 * real `ErrorEvent` satisfies it directly and `beforeSend` can hand one over
 * with no cast at all. Two things make that work, and both are deliberate:
 *
 *   - Every field this module does not itself read is `unknown` rather than a
 *     narrower type. `scrubValue` walks whatever it is given, so a precise type
 *     would buy nothing and would only be one more thing to keep in step with a
 *     dependency's minor releases.
 *   - There is no `[key: string]: unknown` index signature. It reads like it
 *     costs nothing, but TypeScript gives implicit index signatures only to
 *     object *type aliases*, never to interfaces — and Sentry's `Event` and
 *     `RequestEventData` are interfaces, so an index signature here is exactly
 *     what makes a genuine `ErrorEvent` fail to satisfy this type. That is the
 *     mismatch that used to be papered over with a cast in each direction.
 *
 * The unread fields are still listed rather than omitted: they are the places
 * something sensitive actually turns up, and naming them is what makes the test
 * file able to construct a realistic event.
 */
export interface ScrubbableRequest {
  url?: string
  method?: string
  query_string?: unknown
  headers?: unknown
  cookies?: unknown
  env?: unknown
  data?: unknown
}

export interface ScrubbableEvent {
  request?: ScrubbableRequest
  user?: unknown
  extra?: unknown
  contexts?: unknown
  tags?: unknown
  breadcrumbs?: unknown
  exception?: unknown
  message?: unknown
}

function scrubString(value: string): string {
  let scrubbed = value
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    // Fresh lastIndex each time: these are /g and are module-level constants.
    pattern.lastIndex = 0
    scrubbed = scrubbed.replace(pattern, replacement)
  }
  return scrubbed
}

/**
 * Walk anything and return a cleaned copy. Depth-bounded because a Sentry event
 * can contain a cyclic or absurdly deep object graph and a scrubber that hangs
 * on one is a scrubber that takes the process with it.
 */
function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED
  if (typeof value === 'string') return scrubString(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(child, depth + 1)
  }
  return out
}

/**
 * The `beforeSend` body, as a pure function.
 *
 * Returns a new event; the input is not mutated, so a caller that keeps its own
 * reference (Sentry does) never sees a half-scrubbed object.
 *
 * Generic in the event type, so the caller gets back exactly what it passed in.
 * `beforeSend` is handed a `ErrorEvent` and must return a `ErrorEvent`; making
 * this preserve `T` is what lets it do that honestly. The alternative — declare
 * the return as `ScrubbableEvent` and cast it back at the call site — would be
 * a lie in the other direction, because a `ScrubbableEvent` genuinely is not an
 * `ErrorEvent` (it has no required `type`), and the compiler is right to say so.
 *
 * User identity is dropped rather than trimmed. Attaching a buyer's name and
 * email to a stack trace is a judgement call, and the default here is no: this
 * is a small platform where every user is a named individual in a property
 * transaction, the reports go to a third-party service the owner has not yet
 * chosen, and nothing about diagnosing a null dereference needs to know whose
 * request it was. The org and the route are enough to reproduce almost
 * anything. If a future change decides otherwise, it has to delete this line
 * on purpose — which is the point of it being a line rather than an omission.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  // `scrubValue` walks an arbitrary graph and so is honestly typed `unknown`;
  // this is the one assertion, and it is the ordinary "I know what I put in"
  // kind rather than a cast between two types that do not overlap. The
  // intersection is what keeps the caller's own fields visible on the way out.
  const scrubbed = scrubValue(event, 0) as T & ScrubbableEvent

  delete scrubbed.user
  if (scrubbed.request) {
    // Explicit, even though the key rule already catches `cookies`: this is the
    // session cookie, and it is worth being unable to remove it by accident.
    delete scrubbed.request.cookies
    if (typeof scrubbed.request.url === 'string') {
      scrubbed.request.url = scrubString(scrubbed.request.url)
    }
  }

  return scrubbed
}
