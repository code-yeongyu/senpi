// senpi#3566 todo 4: a real session under `--tool-runtime child` runs a child-placed extension tool's file-backed body in
// its own tool child (a different process), emits `session_tool_child` records and reports the child on its row.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../../src/cli/tool-runtime.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness } from "./harness.ts";

const EXTENSION = `import { Type } from "typebox";
export default function (pi) {
	pi.registerTool({
		name: "child_body",
		label: "child body",
		description: "runs its body on the session's tool child",
		placement: "child",
		childModule: { path: "./body.ts", export: "run" },
		parameters: Type.Object({ word: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "in-process" }], details: { pid: process.pid } }),
	});
	pi.registerTool({
		name: "child_sleeper",
		label: "child sleeper",
		description: "starts a long command from the tool child",
		placement: "child",
		childModule: { path: "./body.ts", export: "sleeper" },
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "in-process" }], details: {} }),
	});
}
`;

const BODY = `import { spawn } from "node:child_process";
export function sleeper() {
	const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
	child.unref();
	return { content: [{ type: "text", text: "started" }], details: { sleepPid: child.pid, childPid: process.pid } };
}
export function run(input) {
	return { content: [{ type: "text", text: input.params.word + " from " + process.pid }], details: { pid: process.pid } };
}
`;

async function sessionWithExtension(toolRuntime: ToolRuntimeKind) {
	const dir = mkdtempSync(join(tmpdir(), "session-tool-child-"));
	const extensionDir = join(dir, "ext");
	mkdirSync(extensionDir);
	writeFileSync(join(extensionDir, "index.ts"), EXTENSION);
	writeFileSync(join(extensionDir, "body.ts"), BODY);
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: join(dir, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		additionalExtensionPaths: [join(extensionDir, "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader, cwd: dir, toolRuntime });
	await harness.session.bindExtensions({});
	return {
		harness,
		cleanup: () => {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe.skipIf(process.platform === "win32")("a session's tool child", () => {
	it("under child, runs the tool's body in a separate process and reports spawned / live", async () => {
		const { harness, cleanup } = await sessionWithExtension("child");
		const events: AgentSessionEvent[] = [];
		const unsubscribe = harness.session.subscribe((event) => events.push(event));
		try {
			expect(harness.session.toolChildRow()).toEqual({ state: "none" });
			const result = await harness.session.executeTool("child_body", { word: "hello" });
			const pid = (result.details as { pid: number }).pid;
			expect(result.isError ?? false).toBe(false);
			expect(pid).not.toBe(process.pid);
			expect(result.content).toEqual([{ type: "text", text: `hello from ${pid}` }]);
			expect(events.filter((event) => event.type === "session_tool_child")).toEqual([
				{ type: "session_tool_child", state: "spawned", generation: 1, pid },
			]);
			expect(harness.session.toolChildRow()).toEqual({ state: "live", generation: 1, pid });
		} finally {
			unsubscribe();
			cleanup();
		}
	}, 90_000);

	it("under in-process, runs execute on the host and starts no child", async () => {
		const { harness, cleanup } = await sessionWithExtension("in-process");
		try {
			const result = await harness.session.executeTool("child_body", { word: "hello" });
			expect(result.content).toEqual([{ type: "text", text: "in-process" }]);
			expect((result.details as { pid: number }).pid).toBe(process.pid);
			expect(harness.session.toolChildRow()).toEqual({ state: "none" });
		} finally {
			cleanup();
		}
	}, 90_000);

	it("under child, closing the session ends the child and every command it launched before dispose settles", async () => {
		const { harness, cleanup } = await sessionWithExtension("child");
		try {
			const result = await harness.session.executeTool("child_sleeper", {});
			const { sleepPid, childPid } = result.details as { sleepPid: number; childPid: number };
			const alive = (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			expect([alive(sleepPid), alive(childPid)]).toEqual([true, true]);
			harness.session.dispose();
			await harness.session.whenToolChildClosed();
			expect([alive(sleepPid), alive(childPid)]).toEqual([false, false]);
		} finally {
			cleanup();
		}
	}, 90_000);
});
