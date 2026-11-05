// senpi#5227 (RT12, brain/hand split): a runtime without a session builds the tool-child runtime (dispatcher, tool
// child, host calls), and killing that child mid-call gives today's outcome (KILL-CHILD, plan 3.5). Guards the F27
// tool-child offload surface. Real child process through the production role entry.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionToolChildRecord } from "../../src/modes/rpc/tool-child/session-child.ts";
import {
	KILL_CHILD_CASES,
	KILL_CHILD_MODULE,
	runKillChildCase,
} from "../../src/core/tool-dispatch/testing/kill-child.ts";
import { createToolChildRuntime, type ToolChildRuntime } from "../../src/core/tool-dispatch/tool-child-runtime.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../src/tool-child-main.ts");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function childRuntime(scopeId: string): {
	runtime: ToolChildRuntime;
	modulePath: string;
	workDir: string;
	agentDir: string;
	records: SessionToolChildRecord[];
} {
	const workDir = mkdtempSync(join(tmpdir(), "rt12-"));
	const extensionDir = join(workDir, "ext");
	const agentDir = join(workDir, "agent");
	mkdirSync(extensionDir);
	const modulePath = join(extensionDir, "kill.ts");
	writeFileSync(modulePath, KILL_CHILD_MODULE);
	const records: SessionToolChildRecord[] = [];
	const runtime = createToolChildRuntime({
		toolRuntime: "child",
		agentDir,
		scopeId,
		cwd: workDir,
		moduleRoots: () => [extensionDir],
		hostCallDeps: {
			cwd: workDir,
			executeNested: () => Promise.reject(new Error("no nested calls in this runtime")),
			callableToolNames: () => [],
			target: () => undefined,
			filesystemPolicy: () => undefined,
		},
		onRecord: (record) => records.push(record),
		command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
	});
	cleanups.push(async () => {
		await runtime.toolChild?.close();
		rmSync(workDir, { recursive: true, force: true });
	});
	return { runtime, modulePath, workDir, agentDir, records };
}

describe.skipIf(process.platform === "win32")("tool-child runtime without a session (senpi#5227)", () => {
	it("builds an in-process runtime with no tool child", () => {
		const runtime = createToolChildRuntime({
			toolRuntime: "in-process",
			agentDir: tmpdir(),
			scopeId: "scope-in-process",
			cwd: process.cwd(),
			moduleRoots: () => [],
			hostCallDeps: {
				cwd: process.cwd(),
				executeNested: () => Promise.reject(new Error("unused")),
				callableToolNames: () => [],
				target: () => undefined,
				filesystemPolicy: () => undefined,
			},
			onRecord: () => {},
		});

		expect(runtime.dispatcher.kind).toBe("in-process");
		expect(runtime.toolChild).toBeUndefined();
	});

	it("runs a module job on the child it owns, keyed by its scope", async () => {
		const { runtime, modulePath, workDir, agentDir, records } = childRuntime("scope-a");

		const outcome = await runtime.dispatcher.offload(
			{ modulePath, export: "survive", args: { log: join(workDir, "survive.log") } },
			undefined,
		);

		expect(outcome.placement).toBe("child");
		expect(outcome.generation).toBe(1);
		expect(outcome.pid).not.toBe(process.pid);
		expect(records.map((record) => record.state)).toEqual(["spawned"]);
		expect(existsSync(join(agentDir, "tool-children", "scope-a"))).toBe(true);
	}, 60_000);

	it.each(KILL_CHILD_CASES)(
		"$id: $kill gives today's outcome",
		async (killCase) => {
			const { runtime, modulePath, workDir, records } = childRuntime(killCase.id);

			const outcome = await runKillChildCase(runtime.dispatcher, modulePath, workDir, killCase);

			expect(outcome).toEqual(killCase.expected);
			expect(records.map((record) => [record.state, record.generation])).toEqual(killCase.records);
		},
		90_000,
	);
});
