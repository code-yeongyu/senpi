/**
 * The QA fixture tools (`qa-tools-extension.ts`, senpi#3566 todo 5). `qa_spawn` runs every launch API
 * for real: the Node APIs in this worker, the Bun APIs in a `bun` subprocess, since Vitest runs on Node.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { fileCreated } from "./qa-tools/file-created.ts";
import { type SpawnApi, type SpawnFixtureResult, spawnFixture } from "./qa-tools/spawn-fixture.ts";
import {
	blobText,
	createQaTools,
	mutateFile,
	QA_TOOL_PLACEMENTS,
	raiseSegv,
	runHostcalls,
	sinkDigest,
} from "./qa-tools-extension.ts";

const dirs: string[] = [];
async function controlDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "qat-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fileAppears = fileCreated;

const spawnModule = fileURLToPath(new URL("./qa-tools/spawn-fixture.ts", import.meta.url));
function spawnUnderBun(api: SpawnApi, argv: string[], detached: boolean, dir: string): SpawnFixtureResult {
	const script = `import { spawnFixture } from ${JSON.stringify(spawnModule)};
process.stdout.write(JSON.stringify(await spawnFixture(${JSON.stringify({ api, argv, detached })}, ${JSON.stringify({ controlDir: dir, launchId: `bun-${api}` })})));`;
	const output = execFileSync("bun", ["-e", script], { encoding: "utf8" });
	const parsed: SpawnFixtureResult = JSON.parse(output);
	return parsed;
}

describe("qa fixture tools", () => {
	test("every fixture tool is registered with its placement", () => {
		const names = createQaTools().map((tool) => tool.name);
		expect(names.sort()).toEqual(
			["qa_blob", "qa_blob_server", "qa_hostcall", "qa_mutate", "qa_segv", "qa_sink", "qa_sleep", "qa_spawn"].sort(),
		);
		expect(QA_TOOL_PLACEMENTS.qa_blob_server).toBe("server");
		expect(QA_TOOL_PLACEMENTS.qa_blob).toBe("child");
	});

	test("qa_blob{bytes:20971520} returns exactly 20 MiB", () => {
		expect(Buffer.byteLength(blobText(20_971_520), "utf8")).toBe(20_971_520);
	});

	test("qa_sink returns the sha256 of its input", () => {
		const payload = "payload-✓".repeat(1000);
		expect(sinkDigest(payload)).toBe(createHash("sha256").update(payload, "utf8").digest("hex"));
	});

	test("qa_hostcall reports per-call outcomes", async () => {
		let call = 0;
		const outcomes = await runHostcalls({ tool: "todo", args: { op: "view" }, count: 3 }, async () => {
			call += 1;
			return { isError: call === 2, text: `call ${call}` };
		});
		expect(outcomes).toEqual([
			{ index: 0, isError: false, text: "call 1" },
			{ index: 1, isError: true, text: "call 2" },
			{ index: 2, isError: false, text: "call 3" },
		]);
	});

	test("qa_segv raises SIGSEGV in its own process", async () => {
		const signals: string[] = [];
		const exits: number[] = [];
		const deps = {
			kill: (_pid: number, signal: NodeJS.Signals) => signals.push(signal),
			exit: (code: number) => exits.push(code),
		};
		raiseSegv({ ...deps, platform: "linux" });
		raiseSegv({ ...deps, platform: "win32" });
		expect(signals).toEqual(["SIGSEGV"]);
		expect(exits).toEqual([0xc0000005]);
	});

	test("qa_mutate suspends under SUSPEND_WRITE until release-write, then appends", async () => {
		const dir = await controlDir();
		const target = join(dir, "target.txt");
		await writeFile(target, "a\n");
		const suspended = fileAppears(dir, "write-suspended");
		const mutation = mutateFile({ path: target, line: "b" }, { suspend: true, controlDir: dir });
		await suspended;
		await writeFile(join(dir, "release-write"), "");
		await mutation;
		expect(await readFile(target, "utf8")).toBe("a\nb\n");
	});
});

describe.skipIf(process.platform === "win32")("qa_spawn launch APIs (POSIX)", () => {
	const owned: { api: SpawnApi; underBun: boolean }[] = [
		{ api: "cp.spawn", underBun: false },
		{ api: "cp.spawnSync", underBun: false },
		{ api: "cp.execFileSync", underBun: false },
		{ api: "bun.spawn", underBun: true },
		{ api: "bun.spawnSync", underBun: true },
		{ api: "bun.shell", underBun: true },
	];

	for (const { api, underBun } of owned) {
		test(`${api} returns containment, lifetime, pgid, markerSeen and exitCode`, async () => {
			const dir = await controlDir();
			const result = underBun
				? spawnUnderBun(api, ["true"], false, dir)
				: await spawnFixture({ api, argv: ["true"] }, { controlDir: dir, launchId: `node-${api}` });
			expect(result).toMatchObject({ lifetime: "owned", markerSeen: true, exitCode: 0 });
			expect(["own-group", "inherited"]).toContain(result.containment);
			expect(typeof result.pgid).toBe("number");
		});
	}

	for (const { api, underBun } of [
		{ api: "cp.spawn" as const, underBun: false },
		{ api: "bun.spawn" as const, underBun: true },
	]) {
		test(`${api} detached runs in its own group and survives the call`, async () => {
			const dir = await controlDir();
			const result = underBun
				? spawnUnderBun(api, ["sleep", "30"], true, dir)
				: await spawnFixture({ api, argv: ["sleep", "30"], detached: true }, { controlDir: dir, launchId: "det" });
			expect(result).toMatchObject({ lifetime: "detached", containment: "own-group", markerSeen: true });
			expect(result.exitCode).toBeUndefined();
			const pgid = result.pgid ?? 0;
			expect(() => process.kill(-pgid, 0)).not.toThrow();
			process.kill(-pgid, "SIGKILL");
		});
	}

	test("qa_spawn{gate:true} stays running after its marker until release-gate, then exits 0", async () => {
		const dir = await controlDir();
		const marker = fileAppears(dir, "marker-gated");
		let settled = false;
		const run = spawnFixture(
			{ api: "cp.spawn", argv: ["true"], gate: true },
			{ controlDir: dir, launchId: "gated" },
		).then((result) => {
			settled = true;
			return result;
		});
		await marker;
		expect(settled).toBe(false);
		const gate = await open(join(dir, "gate-gated"), "w");
		await gate.write("go\n");
		await gate.close();
		const result = await run;
		expect(result).toMatchObject({ markerSeen: true, exitCode: 0, lifetime: "owned" });
	});

	test("an API that cannot detach refuses detached instead of ignoring it", async () => {
		const dir = await controlDir();
		await expect(
			spawnFixture({ api: "cp.spawnSync", argv: ["true"], detached: true }, { controlDir: dir, launchId: "x" }),
		).rejects.toThrow(/detached_unsupported/);
	});
});
