# War.app client releases: how they ship, what breaks, how to update

warapp-mcp decodes boards with war.app's own web client (`ujs.js`, see [WEB-PROTOCOL.md](WEB-PROTOCOL.md)), so
every client release matters to it. This page records what was learnt on 2026-11-17 from 98 archived builds
(2018-10 to 2026-11, from the Wayback Machine and the bundle cache) and from probing war.app live, so that the
next update is planned work, not an outage.

## The version number

A page loads the client as `https://warappcdn.com/js/Release/ujs.js?v=<n>`. `<n>` is the **build time in .NET
ticks** (100 ns since 0001-01-01), in **US Pacific local time**: 639304508939095333 is 2026-11-16 18:34 Pacific,
2026-11-17 02:34 UTC. It orders builds; it is not a counter. The client's own version string is in the bundle:
`warlight.shared.Version.get_Current` returns e.g. `"v6.08.0.2"`.

## How the CDN serves builds

`warappcdn.com` is Cloudflare in front of war.app, and **the origin ignores `?v=`**: it always returns the
current build. Cloudflare caches each exact URL for a year (`cache-control: max-age=31536000`), so an old build
can be downloaded **only while Cloudflare still holds that URL in cache**. A build nobody fetched, or one evicted
from cache, is gone: the old URL then serves the current build, and its digest no longer matches. (The first
6.08 build, 639304451701341657, was lost this way within hours.) So:

- keep every build the server sees; never count on downloading one later;
- `KNOWN_GOOD_BUNDLE`'s download by version works only while that URL is cached. The recorded builds kept in
  `<dataDir>/bundle/` are what the stand-in really rests on.

## When builds ship

| Kind | Example | Cadence | Announced |
|---|---|---|---|
| Feature release | 6.06, 6.07, 6.08 | every 2–5 weeks in 2026, any weekday, any hour | a war.app blog post, "Update 6.0x: …", **3–25 minutes after the build goes live** |
| Small update | 6.02.1, 6.05.1 | between releases | a short blog post ("Small update") |
| Hotfix | 6.08.0.1 → 6.08.0.2 | hours or days after a release, often in bursts | none |

The pace is rising: the median gap between builds was 22 days in 2024, 10 in 2025 and 5 in 2026. 11 of 98
builds came within a day of the one before. The blog (`https://war.app/blog/`, with an RSS feed) is the
earliest public signal and names the features.

Build vs blog post (UTC), since build times were read as Pacific:

| Update | Build live | Blog post |
|---|---|---|
| 6.04 | 2026-08-09 21:21 | 21:43 |
| 6.05 | 2026-08-28 14:14 | 14:31 |
| 6.05.1 | 2026-09-24 17:26 | 17:38 |
| 6.06 | 2026-10-02 19:09 | 19:12 |
| 6.08 | 2026-11-17 00:59 | 01:15 |

## What changes, and what each change breaks here

- **Every build re-minifies the code, hotfixes included.** The minified names of the binary reader's methods and
  of the reader helpers (`P.Ya`, …) change, so `DEFAULT_DIALECT` stops matching and the bundle is refused at
  load. The class names the decoder looks up (`W["…"]`, `GameMessage`, …) and the `.Ha` readers do not change.
  This is what the stand-in (#341, #344) covers: the last build that worked decodes instead.
- **Feature releases usually bump the protocol version by one**, and hotfixes never do:

  | Client | Protocol |
  |---|---|
  | 5.24 / 5.24.1 / 5.25 / 5.25.1 / 5.26 | 209 / 210 / 211 / 212 / 213 |
  | 5.34 | 223 (5.34.1: 224) |
  | 6.00 / 6.00.1 / 6.01 | 236 / 237 / 237 |
  | 6.02 / 6.03 / 6.04 / 6.05 / 6.05.1 | 238 / 239 / 240 / 241 / 241 |
  | 6.06 / 6.07 / 6.08 | 242 / 242 / 243 |

  6.01, 6.05.1 and 6.07 shipped without a bump. A bump comes with new features and new wire fields: 6.08
  (242 → 243) added message reactions, chat images, team surrender, cup tournaments and mod map layers (new
  classes `MessageReaction`, `SharedImages`, `TeamSurrenderPrompt`, `CupUtility`, `ModLayer*`; errors 758–776),
  and `GameMessage` gained two optional lists for the reactions and images. In the bundle, the protocol number
  is the last argument of the request-header writer, `(-2147483648,a,!1,<protocol>)`.

## How long war.app keeps answering an old protocol

Probed live 2026-11-17 with one read-only request (`GetInAppNotifications`, start 0, count 1) framed at each
protocol number, current client 6.08 / 243:

| Protocol in the request header | war.app's answer |
|---|---|
| 243 | parsed in 243's request layout (our 242-layout body got `IncompleteMessage`) |
| 223 – 242 | answered |
| 222 and older | error **48 `ClientOutOfDate`** |

So war.app parses each request in the layout of the protocol it declares and accepts about **21 protocol
versions at once**: the oldest, 223, is client 5.34 (March 2025), about 20 months back. Two consequences:

- **The window to adapt is long**: the protocol this server speaks stays accepted well past the next several
  releases. Update deliberately, not in a hurry.
- **When the window closes the sign is error 48 `ClientOutOfDate`** (49 is `ClientVersionTooHigh`). Treat it
  as "this server's protocol is retired". (#344's closed-window check does not name error 48 yet.)

To re-measure: frame the same read with the protocol field (the header's first uint16) set to older values and
look for error 48 in the reply (byte 15 = 5, then the int32 code). Read-only; a dozen requests is enough.

## Updating to a new client (issue #340)

1. **Get the build.** Download `ujs.js` from the page's current `?v=` the day it ships, before Cloudflare
   evicts it, and keep it.
2. **Read the release.** The blog post lists the features. Diff the new bundle against the last one: new and
   removed `W["…"]` classes, new error codes (`case N:return"Name"`), the protocol number, the version string.
3. **Map the names.** Derive the new reader-method and helper names (the BinaryReader prototype under
   `W["system.io.BinaryReader"]`, the `P` helpers by what they call) and check them with `verifyDialect`.
4. **Bump the protocol** (`PROTOCOL_VERSION`, `src/protocol/codec.ts`) only with every reader and encoder this
   server uses checked against the new layouts: new optional fields (like `GameMessage`'s two lists) shift every
   field after them. Golden-pin the encoders again from real traffic.
5. **Verify live, read-only first**: a board, the chat, my games; then one write on a game that can take it.
6. **Move the pin**: `KNOWN_GOOD_BUNDLE` to the new build (version and SHA-256), and update this page and
   WEB-PROTOCOL.md's version line.

Until then nothing is urgent: the stand-in decodes, and war.app keeps answering the protocol we speak.

## Possible follow-ups (not built)

- Name error 48 `ClientOutOfDate` in #344's closed-window check.
- Watch the blog's RSS feed so a release (and its feature list) is seen within minutes.
- Keep every build the server sees rather than only the newest recorded ones, since none can be fetched later.
