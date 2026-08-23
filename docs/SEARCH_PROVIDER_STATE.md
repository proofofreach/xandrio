# Search provider state of play

Snapshot of why catalogue search was returning little or nothing, what was
fixed in the code, and what remains blocked upstream. Measured 2026-08-23 from
a single residential network; provider-side behaviour changes without notice,
so re-measure before drawing conclusions from this document.

This records integration state and observed HTTP behaviour. It is not a
statement about legality, nor a promise that any upstream stays reachable.
See `PROVIDER_COMPATIBILITY.md` for the release-facing register.

## Summary

| Source | State | Blocker |
| --- | --- | --- |
| Project Gutenberg | Working | — |
| Internet Archive | Working | — |
| Z-Library | Client fixed; upstream walling | Edge wall (DiamWall), mirror-dependent |
| Anna's Archive | Reports honestly; no results | Edge wall (DDoS-Guard) needs a real browser |
| Standard Ebooks | Correctly unconfigured | Feed moved behind a paid account |
| Generic OPDS | Unchanged | Operator-configured |

Gutenberg and Internet Archive answer normally and cover public-domain
material. A search restricted to the two shadow-library sources looks empty.

## What was actually wrong in our code

Three defects shared one shape: **an upstream failure was reported as a
successful empty result**, which is indistinguishable from "no such book".

1. **Anna's search swallowed the CLI's failure.** `annas-mcp` exits `0` and
   prints `No books found.` even when the search was refused; the refusal
   (`Search request failed {"statusCode": 403}`) appears only on stderr, which
   was discarded. Every blocked search looked like a healthy zero-result
   source. Now an ERROR-level stderr line marks the source unavailable. The
   stream can carry the mirror and the operator key, so it is read as a
   boolean and never logged.

2. **Z-Library never answered the edge's cookie gate.** The edge replies `307`
   to the *same* URL with a `Set-Cookie`, and serves the retry that returns it.
   With `maxRedirects: 0` the client threw on the redirect and never saw the
   header, so every request died on the first hop. Isolated on one mirror:

   | Behaviour | Result |
   | --- | --- |
   | No hop, no cookie (previous behaviour) | `307` dead end |
   | Follow hop, drop cookie | `307` again, indefinitely |
   | Follow hop, return cookie | Through the gate |

3. **A walled Z-Library mirror was treated as terminal.** A wall page threw
   with `retryable: false`, and mirror rotation only triggered on `retryable`,
   so the client gave up on the stored mirror and never tried the others —
   including one that was serving results at the time. A wall page now sets
   `mirrorBlocked`: do not hammer *this* host, but do rotate to the next.

Also fixed: Standard Ebooks failed every search instead of reporting itself
unconfigured; an empty answer from a Z-Library fallback mirror was cached as
the preferred mirror, stranding later searches on a domain returning zero; and
`BOOK_PROXY_URL` never reached Anna's search at all (see below).

## Upstream conditions

**Anna's Archive — DDoS-Guard.** An anonymous request is answered `302` to
`?check=1` then `403`, serving a JS challenge page.

The decisive measurement: from the **same machine and the same public address**,
at the same moment, `curl` received `403` while ordinary Chrome cleared the
challenge and rendered 50 result cards. The discriminator is not the address —
it is a real browser session executing the challenge. A Playwright stealth
browser on that same address also failed to clear it.

Consequence: routing egress through a different address does not help here, and
neither does moving the request to the user's device for its address alone.

**Z-Library — DiamWall.** Two stages: a `Set-Cookie` gate (an HTTP client can
and now does satisfy this), then a `513`/`517` "Access Denied" page whose
`dwid` cookie is set by JavaScript. Mirror behaviour differed within minutes:
four mirrors returned `513` while `z-lib.gd` returned `200` with results, then
degraded to `503` and connect timeouts. Authenticating with the stored session
made no difference — the wall sits in front of the API. Request volume during
testing appeared to escalate the walling.

**Standard Ebooks.** `/feeds/opds`, `/feeds/opds/all` and
`/feeds/opds/new-releases` all return `401` anonymously; the feeds now require
a Patrons Circle account. Set `STANDARD_EBOOKS_OPDS_USER` /
`STANDARD_EBOOKS_OPDS_PASSWORD` to enable the source; without them it reports
itself unconfigured rather than failing every search.

## Client-side fetching does not work

Moving provider requests into the browser was tested and is a dead end,
independent of any address question:

| Attempt | Result |
| --- | --- |
| `fetch()` from the app origin | `TypeError: Failed to fetch` |
| `fetch()` from a page with no CSP | `TypeError: Failed to fetch` |
| `fetch(mode:'no-cors')` | `opaque`, `status 0`, **0 bytes readable** |
| `<iframe>` + DOM read | `SecurityError` (cross-origin) |

Neither provider sends `Access-Control-Allow-Origin`. The `no-cors` row is the
whole story: the request leaves and arrives, and the page can read nothing.
Relaxing our own `connect-src 'self'` changes nothing and would only weaken the
app. A browser extension is the one design that avoids this, because extensions
with host permissions are not subject to CORS — at the cost of a separate
artifact, per browser, that only works while that browser is open.

## Egress proxy

`BOOK_PROXY_URL` is the book-acquisition egress: Z-Library, Gutendex, and
Anna's downloads all pass it to `requestRemote`. Anna's *search* did not — it
runs through `annas-mcp`, which takes its proxy from the environment, so the
one request most likely to be refused was the only one still leaving from the
server's own address. The CLI is now handed the value as `HTTP(S)_PROXY`;
verified against a logging CONNECT proxy, which observed
`CONNECT annas-archive.gl:443`.

Expected benefit, given the measurements above:

- **Z-Library** — plausible. Its failure is address- and mirror-dependent.
- **Anna's Archive** — unlikely on its own. The blocker is challenge execution,
  not the address.

A proxy sharing the server's already-refused address changes nothing.

## Recommended posture

1. Keep Gutenberg and Internet Archive enabled; they carry public-domain
   search today.
2. Point `BOOK_PROXY_URL` at a clean egress and re-measure Z-Library.
3. Treat Anna's automated search as best-effort. `ANNAS_BROWSER_SEARCH_MODE`
   stays disabled by default and should only be enabled after reviewing the
   provider's current terms.
4. Re-measure before concluding anything from this file. Every number here is
   a snapshot from one network on one day.
