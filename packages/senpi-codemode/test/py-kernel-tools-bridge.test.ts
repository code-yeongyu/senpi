import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentToolResult, type ExtensionContext, kernelToolsStorage } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../src/interpreters/detect.ts";
import type { KernelToolsCapability } from "../src/kernels/js/kernel-tools-types.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalLanguage } from "../src/tool/types.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

const settings = { ...defaultCodemodeSettings, languages: { js: true, py: true, rb: false, jl: false } };
const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function answer(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

type DescribedTool = {
	readonly name: string;
	readonly language: string;
	readonly kernel_generation: number;
	readonly definition_revision: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The first descriptor of a describe reply, or undefined when the reply holds no usable one. */
function describedTool(reply: unknown): DescribedTool | undefined {
	const first = isRecord(reply) && Array.isArray(reply.results) ? reply.results[0] : undefined;
	const descriptor = isRecord(first) && first.ok === true && isRecord(first.descriptor) ? first.descriptor : undefined;
	if (descriptor === undefined) return undefined;
	const { name, language, kernel_generation, definition_revision } = descriptor;
	if (typeof name !== "string" || typeof language !== "string") return undefined;
	if (typeof kernel_generation !== "number" || typeof definition_revision !== "number") return undefined;
	return { name, language, kernel_generation, definition_revision };
}

type HostCall = { readonly toolName: string; readonly args: unknown; readonly sawKernelTools: boolean };

/**
 * A host whose task tool does what omo's does with a grant: read the caller's kernel-tools capability, describe the
 * requested names, and call them. Here it calls `add(1, 2)` and answers with the result, or says it had no capability.
 */
async function session() {
	const root = await mkdtemp(join(tmpdir(), "senpi-py-kernel-tools-"));
	const calls: HostCall[] = [];
	const gate = Promise.withResolvers<void>();
	const gateReached = Promise.withResolvers<void>();
	const executeTool = async (toolName: string, args: unknown): Promise<AgentToolResult<unknown>> => {
		if (toolName === "gate") {
			gateReached.resolve();
			await gate.promise;
			return answer("gate opened");
		}
		const capability = kernelToolsStorage.getStore();
		calls.push({ toolName, args, sawKernelTools: capability !== undefined });
		if (capability === undefined) return answer("no kernel tools for this call");
		const described = describedTool(await capability.describe(["add"]));
		if (described === undefined) return answer("describe failed");
		const value = await capability.invoke({
			name: described.name,
			kernel_generation: described.kernel_generation,
			definition_revision: described.definition_revision,
			args: { a: 1, b: 2 },
			call_id: `host-${crypto.randomUUID()}`,
		});
		return answer(`${described.language}:add -> ${JSON.stringify(value)}`);
	};
	const complete = async () => {
		throw new Error("no provider calls in this test");
	};
	const manager = await createCodemodeSessionManager({
		sessionId: `py-kernel-tools-${crypto.randomUUID()}`,
		cwd: root,
		settings,
		availability,
		executeTool,
		complete,
	});
	const bound: string[] = [];
	const recordingManager = {
		getKernel: (language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void) =>
			manager.getKernel(language, onMessage),
		releaseKernelListener: (language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void) =>
			manager.releaseKernelListener?.(language, onMessage),
		setContext: (context: ExtensionContext) => manager.setContext?.(context),
		bindCellKernelTools: (token: string, capability: KernelToolsCapability) => {
			bound.push(token);
			return manager.bindCellKernelTools?.(token, capability) ?? (() => undefined);
		},
	};
	const tool = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: recordingManager,
		executeTool,
		cellTimeoutSeconds: 120,
	});
	cleanups.push(async () => {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const context = { ...fakeExtensionContext(), cwd: root };
	const run = async (code: string, language: "py" | "js" = "py", cellId = `py-kernel-tools-${crypto.randomUUID()}`) =>
		await tool.execute(cellId, { language, code, summary: "Run a cell" }, undefined, undefined, context);
	return { root, run, calls, bound, gate, gateReached };
}

const DEFINE_ADD = '@tool\ndef add(a: int, b: int) -> int:\n    """Add two integers."""\n    return a + b\n"defined"';

describe.skipIf(!availability.py.detected.ok)("Given a Python cell that defined @tool add", () => {
	it("When the cell grants it through a host tool, then the host sees the cell's kernel tools and add runs back in the kernel", async () => {
		const { run, calls } = await session();
		await run(DEFINE_ADD);

		const granted = await run("tool.task(prompt='use add', tools=['add'])");

		expect(textOf(granted)).toContain("py:add -> 3");
		expect(calls.at(-1)?.sawKernelTools).toBe(true);
	}, 120_000);

	it("When the cell calls agent(..., tools=[...]), then the grant reaches the host task tool with the cell's kernel tools", async () => {
		const { run, calls } = await session();
		await run(DEFINE_ADD);

		await run("agent('use add', tools=['add'])");

		const task = calls.at(-1);
		expect(task?.args).toMatchObject({ prompt: "use add", tools: ["add"] });
		expect(task?.sawKernelTools).toBe(true);
	}, 120_000);

	it("When agent(tools=...) is given a single string, then it is refused with a typed error before reaching the host", async () => {
		const { run, calls } = await session();
		await run(DEFINE_ADD);
		const before = calls.length;

		const refused = await run(
			"try:\n    agent('use add', tools='add')\nexcept Exception as error:\n    print(error.code)",
		);

		expect(textOf(refused)).toContain("invalid_tools");
		expect(calls).toHaveLength(before);
	}, 120_000);

	it("When a host call carries a secret no running cell holds, then it gets no kernel tools", async () => {
		const { run, calls } = await session();
		await run(DEFINE_ADD);

		const forged = await run(
			"import sys\nsys.modules['__main__'].bridge_post('/call', {'callId': 'py-forged', 'cellToken': 'not-a-running-cell', 'toolName': 'task', 'args': {'prompt': 'use add', 'tools': ['add']}})",
		);

		expect(textOf(forged)).toContain("no kernel tools for this call");
		expect(calls.at(-1)?.sawKernelTools).toBe(false);
	}, 120_000);

	it("When a thread keeps a finished cell's context and calls the host later, then that call gets no kernel tools", async () => {
		const { run, calls } = await session();
		await run(DEFINE_ADD);
		await run(
			[
				"import contextvars, threading",
				"late_go = threading.Event()",
				"late_result = {}",
				"def late_call():",
				"    late_go.wait(30)",
				"    late_result['text'] = tool.task(prompt='use add', tools=['add'])['text']",
				"late_context = contextvars.copy_context()",
				"late_thread = threading.Thread(target=lambda: late_context.run(late_call))",
				"late_thread.start()",
			].join("\n"),
		);

		const later = await run("late_go.set()\nlate_thread.join(30)\nlate_result['text']");

		expect(textOf(later)).toContain("no kernel tools for this call");
		expect(calls.at(-1)?.sawKernelTools).toBe(false);
	}, 120_000);

	it("When a cell's host call names its own model-visible cell id instead of its run's secret, then it gets no kernel tools", async () => {
		const { run, calls } = await session();
		await run(DEFINE_ADD);
		const visibleId = `py-kernel-tools-visible-${crypto.randomUUID()}`;

		const forged = await run(
			[
				"import sys",
				`sys.modules['__main__'].bridge_post('/call', {'callId': 'py-own-id', 'cellToken': '${visibleId}', 'cellId': '${visibleId}', 'toolName': 'task', 'args': {'prompt': 'use add', 'tools': ['add']}})`,
			].join("\n"),
			"py",
			visibleId,
		);

		expect(textOf(forged)).toContain("no kernel tools for this call");
		expect(calls.at(-1)?.sawKernelTools).toBe(false);
	}, 120_000);

	it("When a JavaScript cell and a Python cell run, then only the Python run is bound, under a secret that is not its cell id", async () => {
		const { run, bound } = await session();
		const jsId = `js-cell-${crypto.randomUUID()}`;
		const pyId = `py-cell-${crypto.randomUUID()}`;

		await run("1 + 1", "js", jsId);
		await run(DEFINE_ADD, "py", pyId);

		expect(bound).toHaveLength(1);
		expect(bound).not.toContain(jsId);
		expect(bound).not.toContain(pyId);
	}, 120_000);

	it("When a cell stashes its run's context and a later cell replays a host call in it, then that call gets no kernel tools", async () => {
		const { run, calls } = await session();
		await run(DEFINE_ADD);
		await run("import contextvars\nstashed_context = contextvars.copy_context()");

		const replayed = await run("stashed_context.run(lambda: tool.task(prompt='use add', tools=['add'])['text'])");

		expect(textOf(replayed)).toContain("no kernel tools for this call");
		expect(calls.at(-1)?.sawKernelTools).toBe(false);
	}, 120_000);

	it("When a Python cell names a JavaScript cell that is running right now, then it cannot reach that cell's tools", async () => {
		const { run, calls, gate, gateReached } = await session();
		const jsId = `js-victim-${crypto.randomUUID()}`;
		const victim = run("tool(function secret() { return 'js-secret-42'; });\nawait tool.gate({});", "js", jsId);
		await gateReached.promise;

		const forged = await run(
			`import sys\nsys.modules['__main__'].bridge_post('/call', {'callId': 'py-forged-js', 'cellToken': '${jsId}', 'cellId': '${jsId}', 'toolName': 'task', 'args': {'prompt': 'x', 'tools': ['secret']}})`,
		);
		gate.resolve();
		await victim;

		expect(textOf(forged)).toContain("no kernel tools for this call");
		expect(calls.at(-1)?.sawKernelTools).toBe(false);
	}, 120_000);

	it("When a %load file installs an import finder that raises on cache invalidation, then the next cell still grants its kernel tools and the loaded run's secret is refused", async () => {
		const { root, run, calls } = await session();
		await run(DEFINE_ADD);
		await writeFile(
			join(root, "breaks_imports.py"),
			[
				"import builtins, sys",
				"class RaisingFinder:",
				"    def find_spec(self, *args, **kwargs):",
				"        return None",
				"    def invalidate_caches(self):",
				"        raise RuntimeError('finder broke')",
				"sys.meta_path.insert(0, RaisingFinder())",
				"builtins.STASHED_SECRET = sys.modules['__main__'].CURRENT_CELL_TOKEN.get()",
				"",
			].join("\n"),
		);

		await run("%load ./breaks_imports.py");
		const next = await run("tool.task(prompt='use add', tools=['add'])['text']");
		const replayed = await run(
			"import sys\nsys.modules['__main__'].bridge_post('/call', {'callId': 'py-replay-load', 'cellToken': STASHED_SECRET, 'toolName': 'task', 'args': {'prompt': 'use add', 'tools': ['add']}})['text']",
		);

		expect(textOf(next)).toContain("py:add -> 3");
		expect(textOf(replayed)).toContain("no kernel tools for this call");
		expect(calls.at(-1)?.sawKernelTools).toBe(false);
	}, 120_000);
});
