import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/**
 * Keeps provider MCP clients off the operating-system proxy. Clients built on
 * reqwest (codex's rmcp) fall back to the system proxy whenever no env proxy
 * is set, and route even loopback through it: the system proxy cannot reach
 * 127.0.0.1, answers 502, and the t3-code tool list silently disappears. The
 * system proxy's own exception list does not help. Env-configured proxies do
 * honor NO_PROXY, so keep loopback out of every proxy and, when the user
 * configured no proxy at all, suppress the system fallback with empty values
 * (unset values fall back to it again).
 */
export function withLoopbackProxyBypass(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hasEnvProxy = PROXY_ENV_KEYS.some((key) => (env[key] ?? "").trim() !== "");
  const noProxy = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1,localhost"]
    .flatMap((list) => (list ?? "").split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(",");
  return {
    ...env,
    ...(hasEnvProxy ? {} : Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, ""]))),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
