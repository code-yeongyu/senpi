import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

const CHILD_GRACE_MS = 5_000;

async function withKernel<T>(fn: (kernel: JavaScriptKernel) => Promise<T>): Promise<T> {
	const kernel = new JavaScriptKernel({ sessionId: "child-lifecycle", cwd: process.cwd(), parallelPoolWidth: 2 });
	try {
		return await fn(kernel);
	} finally {
		await kernel.close();
	}
}

function pidOf(result: Extract<KernelToHostMessage, { type: "result" }>): number {
	const pid = Number(result.ok ? result.valueRepr : undefined);
	if (!Number.isInteger(pid) || pid <= 0)
		throw new Error(`expected a child pid, got ${result.ok ? result.valueRepr : "error"}`);
	return pid;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function expectDeadWithin(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	expect(alive(pid), `child ${pid} is still alive after ${timeoutMs}ms`).toBe(false);
}

describe("eval cell child process lifecycle", () => {
	it("kills a Bun.spawn child when the cell settles", async () => {
		await withKernel(async (kernel) => {
			const result = await kernel.run({
				cellId: "spawn-settle",
				code: 'const p = Bun.spawn(["sleep", "60"]); return p.pid',
				timeoutMs: 10_000,
			});
			const pid = pidOf(result);
			await expectDeadWithin(pid, CHILD_GRACE_MS);
		});
	}, 30_000);

	it("kills a Bun.$ child when the cell settles", async () => {
		await withKernel(async (kernel) => {
			const result = await kernel.run({
				cellId: "shell-settle",
				code: "const p = Bun.$`sleep 60`; return p.pid",
				timeoutMs: 10_000,
			});
			const pid = pidOf(result);
			await expectDeadWithin(pid, CHILD_GRACE_MS);
		});
	}, 30_000);

	it("escalates to SIGKILL when a settled cell's child ignores SIGTERM", async () => {
		await withKernel(async (kernel) => {
			const result = await kernel.run({
				cellId: "term-proof-settle",
				code: 'const p = Bun.spawn(["sh", "-c", "trap \'\' TERM; sleep 60"]); return p.pid',
				timeoutMs: 10_000,
			});
			const pid = pidOf(result);
			await expectDeadWithin(pid, CHILD_GRACE_MS);
		});
	}, 30_000);

	it("escalates to SIGKILL for term-proof children on interrupt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-codemode-child-int-"));
		const pidFile = join(dir, "child.pid");
		try {
			await withKernel(async (kernel) => {
				const run = kernel.run({
					cellId: "term-proof-interrupt",
					code: `import { writeFileSync } from "node:fs";
const p = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 60"]);
writeFileSync(${JSON.stringify(pidFile)}, String(p.pid));
await new Promise(() => {})`,
					timeoutMs: 30_000,
				});
				const deadline = Date.now() + 15_000;
				let pid = Number.NaN;
				while (Date.now() < deadline) {
					pid = await readFile(pidFile, "utf8").then(
						(text) => Number(text.trim()),
						() => Number.NaN,
					);
					if (Number.isInteger(pid) && pid > 0) break;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (!Number.isInteger(pid) || pid <= 0) throw new Error("child never wrote its pid");

				await kernel.interrupt("child lifecycle test");
				await run.catch(() => undefined);
				await expectDeadWithin(pid, CHILD_GRACE_MS);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 45_000);
});
