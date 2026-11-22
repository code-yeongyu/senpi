import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../../cli/tool-runtime.ts";
import { AuthStorage } from "../auth-storage.ts";
import { createEventBus } from "../event-bus.ts";
import { kernelToolInvokerStorage, kernelToolsStorage } from "../extensions/kernel-tools-context.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../extensions/loader.ts";
import { ExtensionRunner } from "../extensions/runner.ts";
import type { ExtensionContext, ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { ModelRegistry } from "../model-registry.ts";
import { SessionManager } from "../session-manager.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { createToolDispatcher } from "./tool-dispatcher.ts";

const manager = SessionManager.inMemory();
const contexts: Array<{ name: string; context: ExtensionToolContext | undefined; sessionId?: string }> = [
	{ name: "no context", context: undefined },
	{ name: "observer context", context: {} as ExtensionToolContext },
	{
		name: "child context without readable properties",
		context: new Proxy({} as ExtensionToolContext, {
			get: (_target, key) => {
				throw new Error(`unexpected context access: ${String(key)}`);
			},
		}),
	},
	{ name: "absent session manager", context: { sessionManager: undefined } as unknown as ExtensionToolContext },
	{
		name: "own session manager",
		context: { sessionManager: manager } as unknown as ExtensionToolContext,
		sessionId: manager.getSessionId(),
	},
	{
		name: "inherited session manager",
		context: Object.create({ sessionManager: manager }) as ExtensionToolContext,
		sessionId: manager.getSessionId(),
	},
	{
		name: "lazy session manager",
		context: {
			get sessionManager() {
				return manager;
			},
		} as unknown as ExtensionToolContext,
		sessionId: manager.getSessionId(),
	},
];

// #4390 / #4309: dispatch may legitimately have no context. Such calls must use
// the kernel owner's authority, never a previous dispatch's ambient identity.
describe.each<ToolRuntimeKind>(["in-process", "child"])("invoker context (%s)", (runtime) => {
	describe.each([undefined, { sessionId: "outer-session" }])("with ambient invoker %j", (ambient) => {
		it.each(contexts)("binds only the available host identity: $name", async ({ context, sessionId }) => {
			const dispatcher = createToolDispatcher({ runtime });
			const notices: string[] = [];
			dispatcher.onDispatched((info) => notices.push(info.placement));
			const definition: ToolDefinition = {
				name: "probe",
				label: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async (_id, _params, _signal, _update, receivedContext) => {
					expect(receivedContext).toBe(context);
					const before = kernelToolInvokerStorage.getStore();
					await Promise.resolve();
					expect(kernelToolInvokerStorage.getStore()).toEqual(before);
					return { content: [], details: before };
				},
			};
			const run = async () => {
				// Exercise the actual context-free wrapping path, not a fabricated
				// ToolDispatchCall with a falsely required context.
				const tool = wrapToolDefinition(definition, context ? () => context : undefined, dispatcher);
				const result = await tool.execute("probe", {});
				expect(result.details).toEqual(sessionId === undefined ? undefined : { sessionId });
				expect(kernelToolInvokerStorage.getStore()).toEqual(ambient);
				expect(notices).toEqual(["server"]);
			};
			if (ambient) await kernelToolInvokerStorage.run(ambient, run);
			else await run();
			expect(kernelToolInvokerStorage.getStore()).toBeUndefined();
		});
	});
});

// #4390 review: a child event inherits the parent's task-tool async scope.
// All registered event paths must stamp the child, including captured capabilities.
describe("registered event invoker context", () => {
	const emissions: Array<{ name: string; emit: (runner: ExtensionRunner) => Promise<unknown> }> = [
		{ name: "session event", emit: (runner) => runner.emit({ type: "session_start", reason: "startup" }) },
		{ name: "queued lifecycle", emit: (runner) => runner.emit({ type: "agent_start" }) },
		{
			name: "tool call hook",
			emit: (runner) =>
				runner.emitToolCall({ type: "tool_call", toolName: "probe", toolCallId: "probe", input: {} }),
		},
		{
			name: "tool result hook",
			emit: (runner) =>
				runner.emitToolResult({
					type: "tool_result",
					toolName: "probe",
					toolCallId: "probe",
					input: {},
					content: [],
					details: undefined,
					isError: false,
				}),
		},
		{ name: "context transform", emit: (runner) => runner.emitContext([]) },
		{
			name: "preview-safe prompt hook",
			emit: (runner) =>
				runner.emitBeforeAgentStart("probe", undefined, "", { cwd: process.cwd() }, { preview: true }),
		},
	];

	// Session replacement reports removed extensions on the old, already invalidated runner.
	it("runs a stale runner's handler without borrowing the emitting scope's invoker", async () => {
		const owner = SessionManager.inMemory();
		const runtime = createExtensionRuntime();
		const observed: Array<{ invoker: unknown; kernelTools: string }> = [];
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("session_extensions_removed", (_event, context) => {
					let kernelTools = "readable";
					try {
						void context.kernelTools;
					} catch (error) {
						kernelTools = error instanceof Error ? error.name : String(error);
					}
					observed.push({ invoker: kernelToolInvokerStorage.getStore(), kernelTools });
				});
			},
			process.cwd(),
			createEventBus(),
			runtime,
			"removed-invoker.ts",
		);
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		runner.invalidate();
		await kernelToolInvokerStorage.run({ sessionId: owner.getSessionId() }, () =>
			runner.emit({
				type: "session_extensions_removed",
				reason: "new",
				removed: [{ path: "removed-invoker.ts", resolvedPath: "removed-invoker.ts" }],
			}),
		);
		expect(observed).toEqual([{ invoker: undefined, kernelTools: "StaleExtensionContextError" }]);
	});

	it.each(emissions)("uses the handler's session for $name", async ({ emit }) => {
		const owner = SessionManager.inMemory();
		const child = SessionManager.inMemory();
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const ownerRunner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), owner, registry);
		const runtime = createExtensionRuntime();
		const observed: string[] = [];
		const request = { name: "probe", kernel_generation: 1, definition_revision: 1, args: {}, call_id: "probe" };
		await kernelToolsStorage.run(
			{
				capabilities: { invokeScope: true },
				describe: async () => undefined,
				invoke: async (_request, options) => {
					if (!options || "aborted" in options || !options.invoker) throw new Error("missing invoker");
					observed.push(options.invoker.sessionId);
				},
			},
			async () => {
				const captured = ownerRunner.createContext().kernelTools;
				if (!captured) throw new Error("missing owner capability");
				const extension = await loadExtensionFromFactory(
					(pi) => {
						const invoke = async (_event: unknown, context: ExtensionContext) => {
							await Promise.resolve();
							await context.kernelTools?.invoke(request);
							await captured.invoke(request);
						};
						pi.on("session_start", invoke);
						pi.on("agent_start", invoke);
						pi.on("tool_call", invoke);
						pi.on("tool_result", invoke);
						pi.on("context", invoke, { mutatesMessages: false });
						pi.on("before_agent_start", invoke, { previewSafe: true });
					},
					process.cwd(),
					createEventBus(),
					runtime,
					"invoker-context.ts",
				);
				const runner = new ExtensionRunner([extension], runtime, process.cwd(), child, registry);
				await kernelToolInvokerStorage.run({ sessionId: owner.getSessionId() }, async () => {
					await emit(runner);
					expect(observed).toEqual([child.getSessionId(), child.getSessionId()]);
					expect(kernelToolInvokerStorage.getStore()).toEqual({ sessionId: owner.getSessionId() });
				});
			},
		);
	});
});
