import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { checkPiProviderStatus, MINIMUM_PI_VERSION, parseDiscoveredModels } from "./PiProvider.ts";

const encoder = new TextEncoder();
const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

/** Deliberately outside the valid pid range so teardown never signals a real process. */
const FAKE_RPC_PID = 999_999_999;

/**
 * In-process fake `pi --mode rpc`: answers `--version` with a fixed version and
 * auto-acks discovery requests with the canned payloads, recording every spawn
 * so tests can assert the cwd that reached the OS.
 */
function piRpcSpawner(options: {
  readonly version?: string;
  readonly models?: unknown;
  readonly commands?: unknown;
}) {
  const spawns: Array<{ readonly args: ReadonlyArray<string>; readonly cwd: string | undefined }> =
    [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("Unexpected shell pipeline.");
      }
      const { args, options: spawnOptions } = command;
      spawns.push({ args, cwd: spawnOptions.cwd });
      if (args.includes("--version")) {
        return processHandle({ stdout: `pi ${options.version ?? "0.84.3"}\n` });
      }

      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      let stdinBuffer = "";
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_RPC_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            stdinBuffer += new TextDecoder().decode(chunk);
            while (true) {
              const newline = stdinBuffer.indexOf("\n");
              if (newline === -1) return;
              const line = stdinBuffer.slice(0, newline);
              stdinBuffer = stdinBuffer.slice(newline + 1);
              if (line.length === 0) continue;
              const record = decodeJsonLine(line) as {
                readonly id?: unknown;
                readonly type?: unknown;
              };
              if (typeof record.id !== "string") continue;
              const data =
                record.type === "get_state"
                  ? { thinkingLevel: "medium" }
                  : record.type === "get_available_models"
                    ? { models: options.models ?? [] }
                    : record.type === "get_commands"
                      ? (options.commands ?? { commands: [] })
                      : undefined;
              yield* Queue.offer(
                stdout,
                new TextEncoder().encode(
                  `${encodeJsonLine({
                    type: "response",
                    id: record.id,
                    command: String(record.type),
                    success: true,
                    data,
                  })}\n`,
                ),
              );
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      return handle;
    }),
  );
  return { spawner, spawns };
}

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the skills discovered in the requested cwd", () =>
    Effect.gen(function* () {
      const { spawner, spawns } = piRpcSpawner({
        models: [{ provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" }],
        commands: {
          commands: [
            {
              name: "skill:repo-tour",
              description: "Tour the repository",
              source: "skill",
              sourceInfo: {
                path: "/workspace-a/.agents/skills/repo-tour/SKILL.md",
                scope: "workspace",
              },
            },
          ],
        },
      });
      const snapshot = yield* checkPiProviderStatus(settings, {}, "/workspace-a").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "ready");
      assert.deepStrictEqual(snapshot.skills, [
        {
          name: "repo-tour",
          path: "/workspace-a/.agents/skills/repo-tour/SKILL.md",
          enabled: true,
          description: "Tour the repository",
          scope: "project",
        },
      ]);
      const rpcSpawn = spawns.find((spawn) => !spawn.args.includes("--version"));
      assert.strictEqual(rpcSpawn?.cwd, "/workspace-a");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not spawn a probe when disabled", () =>
    Effect.gen(function* () {
      const spawns: Array<unknown> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          spawns.push(command);
          throw new Error("A disabled Pi instance must not spawn a process.");
        }),
      );
      const snapshot = yield* checkPiProviderStatus(
        { ...settings, enabled: false },
        {},
        "/workspace-a",
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
      assert.lengthOf(spawns, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("parseDiscoveredModels", () => {
  it("suffixes duplicate display names with their sub-provider", () => {
    const models = parseDiscoveredModels(
      {
        models: [
          { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
          { provider: "opencode-go", id: "gpt-6-luna", name: "GPT-6 Luna" },
        ],
      },
      "high",
    );
    assert.deepEqual(
      models.map((model) => [model.slug, model.name]),
      [
        ["openai-codex/gpt-6-luna", "GPT-6 Luna (Codex)"],
        ["opencode-go/gpt-6-luna", "GPT-6 Luna (OpenCode Go)"],
      ],
    );
  });

  it("leaves unique display names untouched", () => {
    const models = parseDiscoveredModels(
      { models: [{ provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" }] },
      "high",
    );
    assert.deepEqual(
      models.map((model) => model.name),
      ["DeepSeek V4.1 Flash"],
    );
  });

  it("dedupes slugs and drops records missing provider or id", () => {
    const models = parseDiscoveredModels(
      {
        models: [
          { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
          { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna (duplicate)" },
          { id: "orphan", name: "Orphan" },
          { provider: "openai-codex", name: "No Id" },
        ],
      },
      "high",
    );
    assert.deepEqual(
      models.map((model) => [model.slug, model.name]),
      [["openai-codex/gpt-6-luna", "GPT-6 Luna"]],
    );
  });
});
