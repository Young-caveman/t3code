import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  mergeProviderInstanceEnvironment,
  withLoopbackProxyBypass,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("leaves inherited provider homes unchanged", () => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        baseEnv,
      ),
    ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

describe("withLoopbackProxyBypass", () => {
  it("suppresses the system-proxy fallback when the user configured no proxy", () => {
    const env = withLoopbackProxyBypass({ PATH: "/usr/bin" });
    expect(env.HTTP_PROXY).toBe("");
    expect(env.http_proxy).toBe("");
    expect(env.HTTPS_PROXY).toBe("");
    expect(env.ALL_PROXY).toBe("");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(env.no_proxy).toBe("127.0.0.1,localhost");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("keeps user-configured proxies and merges loopback into NO_PROXY", () => {
    const env = withLoopbackProxyBypass({
      HTTP_PROXY: "http://proxy.corp:3128",
      NO_PROXY: "internal.corp",
    });
    expect(env.HTTP_PROXY).toBe("http://proxy.corp:3128");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe("internal.corp,127.0.0.1,localhost");
    expect(env.no_proxy).toBe("internal.corp,127.0.0.1,localhost");
  });
});
