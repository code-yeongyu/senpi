import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import type { ExtensionFactory, ToolDefinition } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ToolDispatchedInfo } from "../../src/core/tool-dispatch/tool-dispatcher.ts";
import { createToolDispatcher, InProcessToolDispatcher } from "../../src/core/tool-dispatch/tool-dispatcher.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import { createHarness, getToolResult } from "./harness.ts";
import {
	dispatchedCollector,
	fakeBashOperations,
	hookCounters,
	probeDefinition,
	stripVolatile,
	textOf,
} from "./tool-dispatcher-seam-support.ts";

describe("ToolDispatcher seam (senpi#3566 todo 2)", () => {
	it("(a) in-process dispatch deep-equals direct execute for read, fallback bash and a custom tool", async () => {
		const harness = await createHarness({ toolRuntime: "in-process" });
		try {
			const dir = harness.tempDir;
			writeFileSync(join(dir, "probe.txt"), "seam-read-content\n");
			const ctx = harness.getExtensionRunner().createToolContext("seam-call", undefined);
			const dispatcher = new InProcessToolDispatcher();
			const cases: Array<{ definition: ToolDefinition<any, any>; params: unknown }> = [
				{ definition: createReadToolDefinition(dir), params: { path: join(dir, "probe.txt") } },
				{ definition: createBashToolDefinition(dir), params: { command: "printf 'bash-ok\\n'" } },
				{ definition: probeDefinition, params: { value: "x" } },
			];
			for (const { definition, params } of cases) {
				const directUpdates: unknown[] = [];
				const dispatchUpdates: unknown[] = [];
				const direct = await definition.execute(
					"seam-call",
					params,
					undefined,
					(update) => directUpdates.push(update),
					ctx,
				);
				const dispatched = await dispatcher.run({
					definition,
					toolCallId: "seam-call",
					params,
					onUpdate: (update) => dispatchUpdates.push(update),
					ctx,
				});
				expect(stripVolatile(dispatched), definition.name).toEqual(stripVolatile(direct));
				expect(stripVolatile(dispatchUpdates), definition.name).toEqual(stripVolatile(directUpdates));
			}
		} finally {
			harness.cleanup();
		}
	});

	it("(b) model-issued, session.executeTool and eval-kernel calls each dispatch once with hooks once", async () => {
		const hooks = hookCounters();
		const harness = await createHarness({ extensionFactories: [hooks.factory], toolRuntime: "in-process" });
		try {
			const dispatched = dispatchedCollector(harness);
			const path = join(harness.tempDir, "probe.txt");
			writeFileSync(path, "model-issued-content");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run read");
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0]).toMatchObject({ placement: "server", pid: process.pid, generation: 0 });
			expect(dispatched[0]?.toolCallId).toBeTruthy();
			expect(textOf(getToolResult(harness, "read"))).toContain("model-issued-content");
			expect(hooks.toolCallHooks).toEqual(["read"]);
			expect(hooks.toolResultHooks).toEqual(["read"]);

			const nested = await harness.session.executeTool("read", { path });
			expect(textOf(nested)).toContain("model-issued-content");
			expect(dispatched).toHaveLength(2);
			expect(hooks.toolCallHooks).toEqual(["read", "read"]);
			expect(hooks.toolResultHooks).toEqual(["read", "read"]);
		} finally {
			harness.cleanup();
		}

		const kernelHooks = hookCounters();
		const dir = mkdtempSync(join(tmpdir(), "seam-dispatch-kernel-"));
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: join(dir, "agent"),
			settingsManager: SettingsManager.inMemory({}),
			extensionFactories: [kernelHooks.factory],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const kernelHarness = await createHarness({ resourceLoader: loader, cwd: dir, toolRuntime: "in-process" });
		try {
			await kernelHarness.session.bindExtensions({});
			const dispatched = dispatchedCollector(kernelHarness);
			const kernelFile = join(dir, "kernel.txt");
			writeFileSync(kernelFile, "kernel-read-content");
			kernelHarness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("eval", {
						language: "js",
						code: `return await tool.read({ path: ${JSON.stringify(kernelFile)} })`,
						summary: "read through the kernel",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await kernelHarness.session.prompt("run eval");
			expect(kernelHooks.toolCallHooks).toEqual(["eval", "read"]);
			expect(kernelHooks.toolResultHooks).toEqual(["read", "eval"]);
			expect(dispatched.map((info) => info.placement)).toEqual(["server", "server"]);
			expect(textOf(getToolResult(kernelHarness, "eval"))).toContain("kernel-read-content");
		} finally {
			kernelHarness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("(c) stub: child-placed tools under child fail with tool_runtime_unavailable and the session stays usable", async () => {
		const childProbe: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "child_probe",
				label: "Child probe",
				description: "Child-placed probe tool",
				placement: "child",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "child-ran" }], details: {} }),
			});
		};
		const harness = await createHarness({ extensionFactories: [childProbe], toolRuntime: "child" });
		try {
			const dispatched = dispatchedCollector(harness);
			const result = await harness.session.executeTool("child_probe", {});
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("tool_runtime_unavailable");
			expect(result.details).toMatchObject({ code: "tool_runtime_unavailable" });
			expect(dispatched).toEqual([]);

			const usable = join(harness.tempDir, "usable.txt");
			writeFileSync(usable, "still-usable");
			const read = await harness.session.executeTool("read", { path: usable });
			expect(textOf(read)).toContain("still-usable");
			expect(dispatched.map((info) => info.placement)).toEqual(["server"]);
		} finally {
			harness.cleanup();
		}
	});

	it("(d) pinned: injected operations keep a child-placed definition on the server with one notice", async () => {
		const harness = await createHarness({ toolRuntime: "in-process" });
		try {
			const operations = fakeBashOperations("pinned-ran\n");
			const pinned: ToolDefinition<any, any> = createBashToolDefinition(harness.tempDir, { operations });
			pinned.placement = "child";
			const notices: Array<{ event: string; tool?: unknown }> = [];
			const dispatcher = createToolDispatcher({
				runtime: "child",
				notify: (event, data) => notices.push({ event, tool: data?.tool }),
			});
			const dispatched: ToolDispatchedInfo[] = [];
			dispatcher.onDispatched((info) => dispatched.push(info));
			const ctx = harness.getExtensionRunner().createToolContext("pinned", undefined);
			const first = await dispatcher.run({
				definition: pinned,
				toolCallId: "pinned-1",
				params: { command: "echo pinned" },
				ctx,
			});
			const second = await dispatcher.run({
				definition: pinned,
				toolCallId: "pinned-2",
				params: { command: "echo pinned" },
				ctx,
			});
			expect(textOf(first)).toContain("pinned-ran");
			expect(textOf(second)).toContain("pinned-ran");
			expect(operations.commands).toEqual(["echo pinned", "echo pinned"]);
			expect(dispatched.map((info) => info.placement)).toEqual(["server", "server"]);
			expect(notices.filter((notice) => notice.event === "tool_placement_pinned")).toEqual([
				{ event: "tool_placement_pinned", tool: "bash" },
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("(d) pinned: a serverPinned child-placed extension tool reports placement server under child", async () => {
		const pinnedProbe: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "pinned_probe",
				label: "Pinned probe",
				description: "Server-pinned child-placed probe tool",
				placement: "child",
				serverPinned: true,
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "pinned-server-ran" }], details: {} }),
			});
		};
		const harness = await createHarness({ extensionFactories: [pinnedProbe], toolRuntime: "child" });
		try {
			const dispatched = dispatchedCollector(harness);
			const result = await harness.session.executeTool("pinned_probe", {});
			expect(textOf(result)).toBe("pinned-server-ran");
			expect(result.isError).not.toBe(true);
			expect(dispatched.map((info) => info.placement)).toEqual(["server"]);
		} finally {
			harness.cleanup();
		}
	});

	it("(e) executeBash resolves operations from the dispatcher and honors an explicit override", async () => {
		const harness = await createHarness({ toolRuntime: "in-process" });
		try {
			const local = await harness.session.executeBash("printf seam-local-ok");
			expect(local.output).toContain("seam-local-ok");
			expect(local.exitCode).toBe(0);

			const operations = fakeBashOperations("override-ran\n");
			const overridden = await harness.session.executeBash("sentinel", undefined, { operations });
			expect(overridden.output).toBe("override-ran\n");
			expect(operations.commands).toEqual(["sentinel"]);
		} finally {
			harness.cleanup();
		}
	});

	it("executeBash without an override runs on the tool child, and a pinned override still runs as given", async () => {
		const harness = await createHarness({ toolRuntime: "child" });
		try {
			const onChild = await harness.session.executeBash("echo parent=$PPID");
			const parent = Number(/parent=(\d+)/.exec(onChild.output)?.[1] ?? Number.NaN);
			expect(parent).not.toBe(process.pid);
			expect(harness.session.toolChildRow()).toMatchObject({ state: "live", pid: parent });
			const operations = fakeBashOperations("still-pinned-ran\n");
			const pinned = await harness.session.executeBash("sentinel", undefined, { operations });
			expect(pinned.output).toBe("still-pinned-ran\n");
		} finally {
			harness.cleanup();
		}
	});
});
