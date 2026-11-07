// senpi#3566 todo 4: the `module` job kind - file-backed modules run in a gated worker of the real tool child, and a
// path outside the granted extension directories is refused (security contract).
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ToolChildClient } from "./client.ts";
import { LaunchLog } from "./descendants.ts";
import { ToolChildJobError } from "./entry.ts";
import { containedModulePath, TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const roleEntry = resolve(import.meta.dirname, "../../../tool-child-main.ts");
const command = { command: process.execPath, args: ["--import", resolver, roleEntry] };
const extensionDir = resolve(import.meta.dirname, "../../../../test/fixtures/module-job-ext");
const modulePath = join(extensionDir, "offload.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startChild(roots: readonly string[], onDir: (dir: string) => void = () => {}) {
	const dir = await mkdtemp(join(tmpdir(), "tmj-"));
	onDir(dir);
	const instance = new ToolChildClient({
		dir,
		cwd: dir,
		command,
		env: { ...process.env, [TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify(roots) },
	});
	await instance.start();
	cleanups.push(async () => {
		await instance.close();
		await rm(dir, { recursive: true, force: true });
	});
	return instance;
}

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
		return undefined;
	} catch (error) {
		return error instanceof ToolChildJobError ? error.code : String(error);
	}
}

describe("module job containment", () => {
	it("accepts a file inside a granted root and refuses one outside, including through a symlink", async () => {
		expect(containedModulePath(modulePath, [extensionDir])).toBe(modulePath);
		const outside = await mkdtemp(join(tmpdir(), "tmj-out-"));
		cleanups.push(() => rm(outside, { recursive: true, force: true }));
		const stray = join(outside, "stray.ts");
		await writeFile(stray, "export const x = 1;");
		expect(codeOf(() => containedModulePath(stray, [extensionDir]))).toBe("module_job_outside_roots");
		const link = join(outside, "link.ts");
		await symlink(modulePath, link);
		expect(containedModulePath(link, [extensionDir])).toBe(modulePath);
		const linkedRoot = join(outside, "linked-root");
		await symlink(outside, linkedRoot);
		expect(codeOf(() => containedModulePath(join(linkedRoot, "stray.ts"), [extensionDir]))).toBe(
			"module_job_outside_roots",
		);
		expect(codeOf(() => containedModulePath(extensionDir, [extensionDir]))).toBe("module_job_outside_roots");
		expect(codeOf(() => containedModulePath(join(extensionDir, "missing.ts"), [extensionDir]))).toBe(
			"offload_module_unavailable",
		);
	});
});

describe.skipIf(process.platform === "win32")("module job in the real tool child", () => {
	it("runs a named export in the child with its launches gated and proven", async () => {
		const instance = await startChild([extensionDir]);
		const value = (await instance.run("module", { modulePath, export: "whoAmI", args: { code: 6 } })) as {
			pid: number;
			status: number;
		};
		expect(value.status).toBe(6);
		expect(value.pid).toBe(instance.pid);
		expect(value.pid).not.toBe(process.pid);
		await instance.close();
		const records = (await readFile(join(instance.dir, "launches.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.find((record) => record.type === "launch")).toMatchObject({
			api: "cp.spawnSync",
			origin: "kernel",
		});
		const proof = records.find((record) => record.type === "launch_proof");
		expect(Number(proof?.ackTick)).toBeLessThan(Number(proof?.invokeTick));
	}, 60_000);

	it("refuses a module outside the granted roots without loading it", async () => {
		const instance = await startChild([join(extensionDir, "nested-root-that-does-not-exist")]);
		await expect(instance.run("module", { modulePath, export: "whoAmI", args: { code: 0 } })).rejects.toThrow(
			/module_job_outside_roots/,
		);
	}, 60_000);

	it("reports a missing export as offload_module_unavailable", async () => {
		const instance = await startChild([extensionDir]);
		await expect(instance.run("module", { modulePath, export: "notAFunction", args: null })).rejects.toThrow(
			/offload_module_unavailable/,
		);
	}, 60_000);
});

/**
 * Holds every `launch` record after the first out of launches.jsonl until the client starts closing (senpi#5026). The log
 * is written off the ack path, so a job's result can reach the caller before that job's launch record lands; a test that
 * reads the log has to await the writes, not race them.
 */
function holdLaterLaunchRecords(): void {
	const record = LaunchLog.prototype.record;
	const close = ToolChildClient.prototype.close;
	const held: Array<() => void> = [];
	let launches = 0;
	vi.spyOn(LaunchLog.prototype, "record").mockImplementation(function (this: LaunchLog, entry) {
		if (entry.type !== "launch" || ++launches === 1) return record.call(this, entry);
		return new Promise<void>((resolveWrite) => held.push(() => resolveWrite(record.call(this, entry))));
	});
	vi.spyOn(ToolChildClient.prototype, "close").mockImplementation(function (this: ToolChildClient) {
		for (const write of held.splice(0)) write();
		return close.call(this);
	});
	onTestFinished(() => {
		vi.restoreAllMocks();
	});
}

describe("launch ids across a generation's workers", () => {
	it("gives each job's worker its own ids: two jobs that each launch once leave two distinct ledger entries", async () => {
		holdLaterLaunchRecords();
		let dir = "";
		const instance = await startChild([extensionDir], (created) => {
			dir = created;
		});
		for (let job = 0; job < 2; job++)
			expect(await instance.run("module", { modulePath, export: "launchTrue", args: null })).toEqual({ ok: true });
		// The launch log is written off the ack path: close() resolves once the generation's teardown has settled every
		// log write, so both launch records are on disk before the read (senpi#5026).
		await instance.close();
		const launches = (await readFile(join(dir, "launches.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; launchId: string })
			.filter((record) => record.type === "launch");
		expect(launches).toHaveLength(2);
		expect(new Set(launches.map((record) => record.launchId)).size).toBe(2);
	}, 60_000);
});

describe("nested workers in a job worker", () => {
	it("refuses a worker thread a module job tries to start, typed", async () => {
		const instance = await startChild([extensionDir]);
		expect(await instance.run("module", { modulePath, export: "startNestedWorker", args: null })).toBe(
			"tool_child_nested_worker_refused",
		);
	}, 60_000);
});
