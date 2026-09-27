import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";
import { ThreadMetadataMcpService } from "../../ThreadMetadataMcpService.ts";
import { OrchestratorToolkitHandlersLive } from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-orchestrator-toolkit-test");
const threadId = ThreadId.make("thread-orchestrator-toolkit-test");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-orchestrator-toolkit-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const delegatedResult: OrchestratorMcpDelegateTaskResult = {
  taskId: NodeId.make("node:delegated-task"),
  childThreadId: ThreadId.make("thread:delegated-child"),
  childRunId: null,
  childNodeId: NodeId.make("node:delegated-child"),
  status: "queued",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
  summary: null,
  resultContextTransferId: null,
  waitTimedOut: false,
};
const threadListResult: OrchestratorMcpThreadListResult = {
  projectId: ProjectId.make("project:orchestrator-toolkit-test"),
  currentThreadId: threadId,
  threads: [],
  nextCursor: null,
  total: 0,
};

const delegatedInputs: Array<OrchestratorMcpDelegateTaskInput> = [];
const listInputs: Array<OrchestratorMcpThreadListInput> = [];
const isThreadListResult = Schema.is(OrchestratorMcpThreadListResult);

const OrchestratorMcpServiceMock = Layer.mock(OrchestratorMcpService, {
  delegateTask: (_scope, input) => {
    delegatedInputs.push(input);
    return Effect.succeed(delegatedResult);
  },
  listThreads: (_scope, input) => {
    listInputs.push(input);
    return Effect.succeed(threadListResult);
  },
  readThread: () =>
    Effect.fail(
      new OrchestratorMcpFailure({ code: "thread_not_found", message: "no such thread" }),
    ),
});

const TestLayer = McpServer.toolkit(OrchestratorToolkit).pipe(
  Layer.provide(OrchestratorToolkitHandlersLive),
  Layer.provide(OrchestratorMcpServiceMock),
  Layer.provide(Layer.mock(ThreadMetadataMcpService, {})),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeServices.layer),
);

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

/**
 * A result that is not flagged as an error must carry `structuredContent`
 * matching the tool's outputSchema: MCP clients with output validation reject
 * anything else with `-32602 Structured content does not match...`. Input
 * failures therefore have to surface as errors, never as success-shaped
 * results.
 */
const expectRetryableError = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content.length).toBeGreaterThan(0);
};

it.effect("parameter validation failures come back as retryable tool errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("delegate_task", { task: 42 });
      expectRetryableError(result);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("declared handler failures come back as retryable tool errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("t3_thread_read", {
        threadId: "thread:orchestrator-toolkit-test",
      });
      expectRetryableError(result);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("delegates with a JSON-stringified target decoded before the handler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("delegate_task", {
        task: "Reply with the single word PONG. Do not use tools.",
        target:
          '{"providerInstanceId": "codex", "model": "gpt-6-luna", "options": {"reasoningEffort": "max"}}',
        mode: "wait",
        title: "PStack probe: codex",
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        taskId: "node:delegated-task",
        childThreadId: "thread:delegated-child",
      });
      expect(delegatedInputs.at(-1)).toMatchObject({
        task: "Reply with the single word PONG. Do not use tools.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-6-luna",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
        mode: "wait",
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("coerces JSON-stringified scalars before the handler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("t3_thread_list", {
        includeSubagents: "true",
        limit: "10",
      });
      expect(result.isError).toBe(false);
      expect(isThreadListResult(result.structuredContent)).toBe(true);
      expect(listInputs.at(-1)).toMatchObject({ includeSubagents: true, limit: 10 });
    }),
  ).pipe(Effect.provide(TestLayer)),
);
