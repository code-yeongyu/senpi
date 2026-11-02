// senpi#3566 todo 6: a job's backstop against a real tool child. The job is rejected with tool_child_deadline and the
// kind's user text; the child it ran on stays alive and serves the next job.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolChildClient } from "./client.ts";
import { TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const extensionDir = resolve(import.meta.dirname, "../../../../test/fixtures/module-job-ext");
const modulePath = join(extensionDir, "offload.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(process.platform === "win32")("job backstop on a real tool child", () => {
	it("rejects a job at its deadline and keeps the child serving", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tjd-"));
		const instance = new ToolChildClient({
			dir,
			cwd: dir,
			command: { command: process.execPath, args: ["--import", resolver, roleEntry] },
			env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify([extensionDir]) },
		});
		cleanups.push(async () => {
			await instance.close();
			await rm(dir, { recursive: true, force: true });
		});
		await instance.start();
		const pid = instance.pid;
		await expect(
			instance.run("module", { modulePath, export: "sleepFor", args: { ms: 5_000 } }, undefined, {
				deadlineMs: 100,
			}),
		).rejects.toMatchObject({ code: "tool_child_deadline" });
		expect(instance.state).toBe("live");
		expect(instance.pid).toBe(pid);
		expect(await instance.run("module", { modulePath, export: "sleepFor", args: { ms: 10 } })).toEqual({ slept: 10 });
	}, 30_000);
});
