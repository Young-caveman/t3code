# 2026-09-27 — Orchestrator MCP tools unusable from provider agents

Two independent defects made the orchestrator V2 MCP toolkit (`t3-code_*`)
unusable from provider agents. Both were reproduced from real thread records,
fixed, and verified live on codex and opencode.

## Symptoms

1. `delegate_task`, `t3_thread_list`, and `t3_thread_read` failed with
   `MCP error -32602: Structured content does not match the tool's output
schema: data must have required property 'taskId' …` (threads `28a1ced6-…`
   and `a46016da-…`).
2. On codex threads the entire `t3-code` tool set was absent (threads
   `2ef11ad3-…`, `05b28495-…`) while opencode threads in the same database saw
   the tools. Native provider subagents kept working on both, which masked the
   difference — "delegation works" was true via the provider harness and false
   via `delegate_task` at the same time.

## Root cause 1: failures encoded as success-shaped results

`effect`'s `McpServer.registerToolkit` mapped every toolkit result to
`isError: false` + `structuredContent`, ignoring `result.isFailure`. Input
validation failures therefore went out as
`structuredContent: {"_tag":"AiError", …}`, which clients that validate
structured output (the `@modelcontextprotocol/sdk` bundled in provider CLIs)
reject with `-32602` before the model can read anything. Declared failures
(`OrchestratorMcpFailure`) hit the same wall: an error envelope can never
satisfy the success `outputSchema` that the tool advertises.

Two things triggered the failure path:

- models stringifying tool arguments — `"limit": "10"`, `"includeSubagents":
"true"`, `target` sent as a JSON string — failing strict input decode;
- legitimate declared failures, which are expected outcomes.

Fixed by:

- `patches/effect@4.0.0-rc.115.patch` — `registerToolkit` honors
  `result.isFailure`: the result goes out as `isError: true` with the payload in
  `content[].text` and **no** `structuredContent`. This is the only envelope
  that clients of every version accept (spec allows omitting `structuredContent`
  on error; validating clients skip it then).
- `packages/contracts/src/orchestratorMcp.ts` — `fromJsonStringCompat` accepts
  the JSON-encoded compatibility shapes at the tool boundary (same precedent as
  `OrchestratorMcpSchedule`) and decodes them to the canonical typed values.
  Encoding stays canonical.

Tests that had codified the old failure envelope (asserting failure payloads in
`structuredContent`) now read the payload from text content via
`failurePayload()`.

## Root cause 2: codex MCP calls routed through the system proxy

Codex threads never received the `t3-code` tools on macOS; the database has
zero codex `dynamic_tool` rows from before the fix, while opencode rows abound.
A credential was issued correctly and `mcp_servers.t3-code` was injected with
the right shape (`url` + `http_headers` both work on codex 0.155), but no
request ever reached the T3 MCP endpoint.

Codex's `rmcp` transport falls back to the operating-system proxy whenever no
env proxy is set, and routes even `127.0.0.1` through it. The system proxy on
this host (Clash, `127.0.0.1:7890`) answers 502 for loopback, rmcp gives up,
and codex silently drops the server — the agent just sees fewer tools. Caught
mid-call with `lsof`: `codex … 127.0.0.1:53402->127.0.0.1:7890 (ESTABLISHED)`.
The proxy's exception list (`localhost`, `127.*`) is not honored by this
client, and `NO_PROXY` alone does not help, because the system-proxy fallback
ignores it.

Fixed by `withLoopbackProxyBypass`
(`apps/server/src/provider/ProviderInstanceEnvironment.ts`), applied to the
codex app-server spawn environment: user-configured env proxies are preserved
(loopback is appended to their `NO_PROXY`, which the env-proxy path does
honor), and when the user configured no proxy at all the system-proxy fallback
is suppressed with empty proxy values.

## Verification

- `vp test run apps/server/src/mcp packages/contracts` (698 tests) and the
  focused tests for both fixes; `tsc --noEmit` clean.
- Live 5-step probe on codex **and** opencode in a fresh thread: capabilities,
  `delegate_task` with a JSON-stringified `target` (cross-provider codex child
  completed with `PONG` and returned `taskId`), `t3_thread_list` /
  `t3_thread_read` with string-typed scalars, and deliberately invalid inputs
  (`{"task": 123}`, `{"task": ""}`) returning readable
  `ToolParameterValidationError` text. No result contained `-32602` or
  `Structured content does not match`.

## Related upstream

- modelcontextprotocol/typescript-sdk#1943 and PR #1945 — client validates
  `structuredContent` against `outputSchema` even on `isError` results. Fixed
  upstream but not in the SDKs provider CLIs bundle today; do not depend on it.
- Effect-TS/effect#7495 — `structuredContent` must stay a JSON object.
- cyanheads/mcp-ts-core#241 — same bug class in another framework; same
  conclusion (do not ship error envelopes as `structuredContent`).

## Traps for future readers

- When a toolset "works in tests but not from the agent", check whether the
  provider ever loaded it: `dynamic_tool` rows in
  `orchestration_v2_projection_turn_items` and MCP request spans in
  `server.trace.ndjson` answer that in seconds. Test harnesses call
  `server.callTool` in-process and bypass every client-side check.
- Anything reqwest-based (codex's `rmcp`) is system-proxy-sensitive: loopback
  endpoints need `NO_PROXY=127.0.0.1,localhost` **and** suppression of the
  system-proxy fallback (empty proxy env values), since the fallback ignores
  both `NO_PROXY` and the system exception list.
- `isError: false` with a non-schema `structuredContent` is a dead end with
  validating clients: failures must omit `structuredContent` entirely.
