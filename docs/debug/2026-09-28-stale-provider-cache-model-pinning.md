# 2026-09-28 — Stale provider cache pins retired Pi models forever

A Mac-only report: the model picker's Pi tab showed hundreds of models that
had no source anywhere — OpenRouter-catalog rows like
`Google: Gemini 3 Flash Preview`, `OpenAI: GPT-4.1 Nano (batch)`, and
`Dots Studio: Dots3-Note Preview (free)`. Every Pi-side cleanup (pruning
`~/.pi/agent/auth.json`, deleting the `models-store.json` catalog sections,
removing the OpenRouter key from `pi-live.json`) left the picker unchanged.
An Omarchy machine with identical Pi settings and the same 40-model Pi
inventory never showed them.

## Evidence that pinned it

- `pi --list-models` and the `get_available_models` RPC returned exactly
  40 models (8 `openai-codex` + 32 `opencode-go`) in every invocation and
  mode, including a full replica of the server's spawn environment.
- A temporary `pi.binaryPath` wrapper teeing the RPC pipes (see traps)
  captured the server's own discovery traffic: `get_available_models`
  returned 40 — no `openrouter/` slugs.
- Yet `~/.t3/caches/pi.json` (the per-instance provider status cache)
  held 465 models (`{openai-codex: 10, opencode-go: 33, deepseek: 4,
openrouter: 417}`) and was rewritten with a **fresh `checkedAt` on every
  refresh**, which made it look current.
- Deleting the cache file while the server was running did not help: the
  in-memory snapshot re-persisted it. Deleting it with the app stopped and
  relaunching produced a clean cache (41 models: default + 8 + 32).

The 465 entries dated from an era when OpenRouter and DeepSeek were logged
into Pi. Those credentials are long gone; the snapshot was not.

## Root cause

Two defects stacked:

1. **The origin**: when extra Pi providers are authenticated, Pi's
   `get_available_models` returns that period's full catalog (438–465
   entries). One such snapshot landed in the provider status cache.
2. **The pinning bug**: `shouldRetainMissingProviderModels` in
   `apps/server/src/provider/Layers/ProviderRegistry.ts` treated Pi as a
   partial-catalog driver (fell through to `return true`). So when a later
   refresh reported the true 40-model inventory, the merge unioned the
   previous 465 back in (`mergeProviderSnapshot` →
   `mergeProviderModels`), re-persisted the result, and stamped it with a
   fresh `checkedAt`. Boot hydration (`providerStatusCache.ts`) then loaded
   that cache as the initial UI snapshot on every start. The stale rows
   could never leave — no amount of upstream cleanup reached them.

`acpRegistry`, `codex`, and `opencode` already had the correct rule:
a completed probe (installed, `ready`, authenticated) **replaces** the
model list, so models that leave a complete inventory actually disappear.
Pi's RPC discovery is equally complete when it is up and authenticated; it
was simply missing from that rule.

## Fix

- `shouldRetainMissingProviderModels` gains a Pi branch with the same
  completed-probe semantics as `acpRegistry` (comment included).
- Two focused tests: a completed Pi probe drops missing models; a failed or
  unauthenticated probe still retains the previous list. The first test was
  verified to fail with the fix reverted.

## Verification

- `vp test run apps/server/src/provider/Layers/ProviderRegistry.test.ts` —
  57 passed (2 new); the new drop test fails without the code change.
- `vp run typecheck` — clean.
- Live: on the affected host, stopping the app, deleting
  `~/.t3/caches/*.json`, and relaunching rebuilt `pi.json` with 41 models
  and no `openrouter/` entries; the picker returned to the subscription
  list.

## Traps for future readers

- **`checkedAt` in a persisted snapshot is not evidence of a fresh probe.**
  Re-persisting an old snapshot restamps it. To check what a provider
  actually reported, read its spawn's RPC response, not the cache age.
- **Catching a provider spawn's RPC**: temporarily point the instance's
  `binaryPath` at a wrapper that tee's stdin/stdout **only for
  `--mode rpc`** and `exec`s the real binary for everything else. A
  wrapper that pipes `--version` as well will hang the version probe
  (stdin stays open) and the UI reports Pi as unavailable. Revert the
  settings entry afterwards.
- **Deleting a stale provider cache requires the app stopped**; a running
  server re-persists its in-memory snapshot immediately.
- **When adding a provider driver with authoritative discovery, extend
  `shouldRetainMissingProviderModels`.** The default is "retain", which is
  correct only for drivers whose probes can be partial; otherwise retired
  models are pinned forever through the snapshot cache.
