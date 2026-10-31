// senpi#3566 todo 6: the session-level policy against real tool children - an idempotent job lost to a child exit is
// retried once on a fresh generation, a non-idempotent one never is, and three exits in 5 s pause the child.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionToolChild } from "./session-child.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const extensionDir = resolve(import.meta.dirname, "../../../../test/fixtures/module-job-ext");
const modulePath = join(extensionDir, "offload.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sessionChild(now: () => number = Date.now) {
	const dir = await mkdtemp(join(tmpdir(), "tsp-"));
	const child = new SessionToolChild({
		dir,
		cwd: dir,
		moduleRoots: () => [extensionDir],
		command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
		onRecord: () => {},
		now,
	});
	cleanups.push(async () => {
		await child.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { child, dir };
}

describe.skipIf(process.platform === "win32")("session tool child policy", () => {
	it("retries an idempotent job lost to a child exit exactly once, on a fresh generation", async () => {
		const { child, dir } = await sessionChild();
		const result = await child.runner(
			{ modulePath, export: "dieOnce", args: { marker: join(dir, "died-once") }, idempotent: true },
			undefined,
		);
		expect(result.generation).toBe(2);
		expect((result.value as { pid: number }).pid).toBe(result.pid);
	}, 60_000);

	it("never retries a non-idempotent job lost to a child exit", async () => {
		const { child, dir } = await sessionChild();
		await expect(
			child.runner({ modulePath, export: "dieOnce", args: { marker: join(dir, "died-once") } }, undefined),
		).rejects.toMatchObject({ code: "tool_child_exited" });
		expect(child.row()).toMatchObject({ state: "exited", generation: 1 });
	}, 60_000);

	it("pauses after three exits within 5 s: the next job is refused without a spawn", async () => {
		const { child } = await sessionChild(() => 0);
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(child.runner({ modulePath, export: "dieAlways", args: null }, undefined)).rejects.toMatchObject({
				code: "tool_child_exited",
			});
		}
		await expect(child.runner({ modulePath, export: "dieAlways", args: null }, undefined)).rejects.toMatchObject({
			code: "tool_child_unavailable",
		});
		expect(child.row()).toMatchObject({ state: "exited", generation: 3 });
	}, 90_000);
});
