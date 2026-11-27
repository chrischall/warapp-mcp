# src/protocol/ — warapp-mcp

What is true of the client protocol, the bundle reader and its dialect. The repo-wide rules are in the root `CLAUDE.md`.

- **The decoder speaks protocol 243 (client v6.08.0.2) and derives the client's names (#340).** Every build renames
  the reader's methods and helpers, so `src/protocol/dialect.ts` derives them from the bundle (classes by registered
  type name, the haxe Input and BinaryReader methods by what they read, the Serializer/SharedUtility/MessagePump/
  Enumerable helpers by canonical form; never runs bundle code); `BundleInterpreter` uses the derived names, falling
  back to the built-in v6.07 ones when any role is missing, and `verifyDialect` still probes the derived helpers
  (`helperClass`, `requiredHelpers` by role). Every hand-written encoder, the `Method` table (243 renumbered it) and
  the positional readers are 243's; a bundle whose readers default to another protocol (`bundleProtocol`) is refused
  at load (`protocol-mismatch`, a stand-in refusal like a dialect one), since war.app answers in the protocol a
  request declares. The pin (`KNOWN_GOOD_BUNDLE`) is 639304508939095333. war.app's CDN serves a build by version only
  while Cloudflare still caches its exact URL (the origin ignores `?v=`: `docs/CLIENT-RELEASES.md`).
  **The last build that worked stands in first (the owner, 2026-11-17: fall back gracefully).** A bundle is recorded in
  `<dataDir>/bundle/known-good.json` (version, digest, `verifiedAt`; newest first, `MAX_KNOWN_GOOD` (3); 0600, atomic,
  path-locked; a file that does not parse is never overwritten) once a live board decodes with it, every byte read and the
  standing read (`readLatestBoard` in `src/tools/live-context.ts` → `markDecoded`, once per loaded bundle). A refused current
  client is stood in for by the recorded builds, newest first, then the pin — each only with its digest, from the cache or
  downloaded by version; every recorded build's copy is kept on disk. The window is `<dataDir>/bundle/stand-in.json`
  (`refusedVersion`, `since`: when that client was first refused here; a newer refused client restarts it, a client that loads
  closes it) and `report().standIn` (`version`, `refusedVersion`, `since`, `reason`): `warapp_session_status` and
  `warapp_healthcheck` report it, and `warapp_plan_turn`, `warapp_check_plan` and the `warapp_submit_turn` preview lead their
  warnings with `standInLine`. While one stands in, a reply that does not decode with it (bytes left over, a frame or layout
  error) or comes in another protocol version (`ProtocolVersionError`) is `StandInClosedError` (war.app no longer answers the
  old build; #340), never a board. Hosted, `MCP_DATA_DIR` holds both files like the cache.
  How and when war.app ships clients, which protocols it still accepts (223–243 on 2026-11-17; older get error 48
  `ClientOutOfDate`, which `WarappRpc` throws as `ClientOutOfDateError`, as it does 49 `ClientVersionTooHigh`) and the checklist for a protocol bump are in `docs/CLIENT-RELEASES.md`; what 243 changed is
  `docs/WEB-PROTOCOL.md` "Protocol 243".
