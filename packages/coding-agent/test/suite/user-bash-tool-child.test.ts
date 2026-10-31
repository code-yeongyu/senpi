// senpi#3566 todo 9: the session's user bash (executeBash) runs on its tool child under --tool-runtime child, streams
// its output, reports the exit code and is aborted by abortBash; under in-process it runs here as before.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../../src/cli/tool-runtime.ts";
import { createHarness } from "./harness.ts";

async function withSession<T>(
	runtime: ToolRuntimeKind,
	body: (session: Awaited<ReturnType<typeof createHarness>>["session"]) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "ubtc-"));
	const harness = await createHarness({ cwd: dir, toolRuntime: runtime });
	try {
		await harness.session.bindExtensions({});
		return await body(harness.session);
	} finally {
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform === "win32")("core bash tool placement", () => {
	it("runs its process on the session's tool child under child and here under in-process", async () => {
		const parents = {} as Record<ToolRuntimeKind, number>;
		for (const runtime of ["child", "in-process"] as const) {
			await withSession(runtime, async (session) => {
				const result = await session.executeTool("bash", { command: "echo parent=$PPID" });
				const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				parents[runtime] = Number(/parent=(\d+)/.exec(text)?.[1] ?? Number.NaN);
				if (Number.isNaN(parents[runtime])) throw new Error(`no parent pid in: ${text.slice(0, 200)}`);
				const row = session.toolChildRow();
				if (runtime === "child") {
					expect(row).toMatchObject({ state: "live", pid: parents[runtime] });
				} else {
					expect(parents[runtime]).toBe(process.pid);
					expect(row).toEqual({ state: "none" });
				}
			});
		}
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("user bash placement", () => {
	it("runs on the session's tool child under child, streaming output and the exit code", async () => {
		await withSession("child", async (session) => {
			const chunks: string[] = [];
			const result = await session.executeBash("echo parent=$PPID; echo streamed; exit 7", (chunk) =>
				chunks.push(chunk),
			);
			const parent = Number(/parent=(\d+)/.exec(result.output)?.[1] ?? Number.NaN);
			expect(parent).not.toBe(process.pid);
			expect(session.toolChildRow()).toMatchObject({ state: "live", pid: parent });
			expect(chunks.join("")).toContain("streamed");
			expect(result.exitCode).toBe(7);
			expect(result.cancelled).toBe(false);
		});
	}, 90_000);

	it("abortBash ends the command on the child within 3 s", async () => {
		await withSession("child", async (session) => {
			let started!: () => void;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			const running = session.executeBash("echo ready; sleep 600", (chunk) => {
				if (chunk.includes("ready")) started();
			});
			await ready;
			const t0 = Date.now();
			session.abortBash();
			const result = await running;
			expect(Date.now() - t0).toBeLessThan(3000);
			expect(result.cancelled).toBe(true);
		});
	}, 90_000);

	it("runs in this process under in-process, with no child", async () => {
		await withSession("in-process", async (session) => {
			const result = await session.executeBash("echo parent=$PPID");
			const parent = Number(/parent=(\d+)/.exec(result.output)?.[1] ?? Number.NaN);
			expect(parent).toBe(process.pid);
			expect(session.toolChildRow()).toEqual({ state: "none" });
		});
	}, 90_000);
});
