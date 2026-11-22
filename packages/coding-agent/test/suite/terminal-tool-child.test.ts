// senpi#3566 todo 9: a session's terminal bash runs on its tool child under --tool-runtime child (the PTY shell's
// parent is the session's child) and in this process under in-process, where nothing about it changes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../../src/cli/tool-runtime.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { createHarness } from "./harness.ts";

async function bashParentPid(runtime: ToolRuntimeKind): Promise<{ parent: number; row: unknown }> {
	const dir = mkdtempSync(join(tmpdir(), "ttc-"));
	const harness = await createHarness({
		cwd: dir,
		toolRuntime: runtime,
		extensionFactories: [registerTerminalExtension],
	});
	try {
		await harness.session.bindExtensions({});
		const result = await harness.session.executeTool("bash", { command: "echo parent=$PPID" });
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		const parent = Number(/parent=(\d+)/.exec(text)?.[1] ?? Number.NaN);
		if (Number.isNaN(parent)) throw new Error(`no parent pid in: ${text.slice(0, 400)}`);
		return { parent, row: harness.session.toolChildRow() };
	} finally {
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

describe.skipIf(process.platform === "win32")("terminal background sessions on the tool child", () => {
	it("a background session started by one call is read by bash_output and ended by kill_bash in later calls", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ttc-bg-"));
		const harness = await createHarness({
			cwd: dir,
			toolRuntime: "child",
			extensionFactories: [registerTerminalExtension],
		});
		try {
			await harness.session.bindExtensions({});
			const started = await harness.session.executeTool("bash", {
				command: "echo parent=$PPID; echo marker-bg; sleep 600",
				run_in_background: true,
			});
			const id = (started.details as { bash_id?: string } | undefined)?.bash_id;
			expect(id, textOf(started)).toBeTypeOf("string");
			let peek = textOf(started);
			for (let i = 0; i < 50 && !peek.includes("marker-bg"); i++) {
				peek += textOf(await harness.session.executeTool("bash_output", { bash_id: id }));
			}
			expect(peek).toContain("marker-bg");
			const parent = Number(/parent=(\d+)/.exec(peek)?.[1] ?? Number.NaN);
			expect(harness.session.toolChildRow()).toMatchObject({ state: "live", pid: parent });
			const killed = textOf(await harness.session.executeTool("kill_bash", { bash_id: id }));
			expect(killed.toLowerCase()).toMatch(/kill|terminat|stop/);
			const after = textOf(await harness.session.executeTool("bash_output", { bash_id: id }));
			expect(after.toLowerCase()).toMatch(/exit|kill|not found|unknown|no (such|session)/);
		} finally {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("terminal bash placement", () => {
	it("runs on the session's tool child under child", async () => {
		const { parent, row } = await bashParentPid("child");
		expect(parent).not.toBe(process.pid);
		expect(row).toMatchObject({ state: "live", pid: parent });
	}, 90_000);

	it("runs in this process under in-process, with no child", async () => {
		const { parent, row } = await bashParentPid("in-process");
		expect(parent).toBe(process.pid);
		expect(row).toEqual({ state: "none" });
	}, 90_000);
});
