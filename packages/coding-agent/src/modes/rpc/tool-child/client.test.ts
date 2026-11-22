// senpi#3566 todo 4: the tool child lifecycle against a real child process.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolChildClient, ToolChildError, type ToolChildStatus } from "./client.ts";
import { defaultGroupProbes } from "./group-ownership.ts";

const fixture = resolve(import.meta.dirname, "../../../../test/fixtures/tool-child-fixture.ts");
const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const command = { command: process.execPath, args: ["--import", resolver, fixture] };

const clients: ToolChildClient[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function client(mode = "serve", extra: { readyMs?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "tcl-"));
	roots.push(root);
	const statuses: ToolChildStatus[] = [];
	const instance = new ToolChildClient({
		dir: join(root, "ch"),
		cwd: root,
		env: { ...process.env, TOOL_CHILD_FIXTURE_MODE: mode },
		command,
		readyMs: extra.readyMs ?? 20_000,
		onStatus: (status) => statuses.push(status),
	});
	clients.push(instance);
	return { instance, statuses };
}

describe("ToolChildClient", () => {
	it("starts a live generation, runs jobs and answers pings", async () => {
		const { instance, statuses } = await client();
		await instance.start();
		expect(instance.state).toBe("live");
		expect(instance.pid).not.toBe(process.pid);
		expect(statuses).toEqual([{ state: "spawned", generation: 1, pid: instance.pid }]);
		expect(await instance.run("echo", { a: [1, 2] })).toEqual({ a: [1, 2] });
		expect(await instance.ping()).toBe(1);
	}, 30_000);

	it("keeps the child's hello manifest and refuses a job of a kind it does not run before sending it", async () => {
		const { instance } = await client();
		await instance.start();
		expect(instance.jobKinds).toContain("echo");
		await expect(instance.run("not-a-kind", {})).rejects.toMatchObject({
			code: "tool_child_unknown_kind",
			message: expect.stringContaining("the child runs [") as unknown as string,
		});
		expect(await instance.run("echo", "still here")).toBe("still here");
	}, 30_000);

	it("keeps the protocol valid when a job writes raw bytes to stdout", async () => {
		const { instance } = await client();
		await instance.start();
		expect(await instance.run("print", null)).toBe("printed");
		expect(await instance.run("echo", "after")).toBe("after");
	}, 30_000);

	it("fails every pending job exactly once when the child dies, and a new generation works", async () => {
		const { instance, statuses } = await client();
		await instance.start();
		const first = instance.run("sleep", null);
		const second = instance.run("sleep", null);
		const killer = instance.run("exit", null);
		for (const job of [first, second, killer]) await expect(job).rejects.toMatchObject({ code: "tool_child_exited" });
		expect(instance.state).toBe("dead");
		expect(statuses.at(-1)).toMatchObject({ state: "exited", generation: 1 });
		await instance.start();
		expect(instance.generation).toBe(2);
		expect(await instance.run("echo", 2)).toBe(2);
	}, 30_000);

	it.skipIf(process.platform === "win32")(
		"sweeps a launched group when the child dies before it finished",
		async () => {
			const { instance } = await client();
			await instance.start();
			const { pid } = (await instance.run("spawnSleep", null)) as { pid: number };
			expect(defaultGroupProbes.groupHasMembers(pid)).toBe(true);
			await expect(instance.run("exit", null)).rejects.toMatchObject({ code: "tool_child_exited" });
			await instance.ended();
			expect(defaultGroupProbes.groupHasMembers(pid)).toBe(false);
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"gates a plain child_process call in a job worker, with an ordered proof",
		async () => {
			const { instance } = await client();
			await instance.start();
			expect(await instance.run("workerSpawn", null)).toEqual({ status: 5 });
			await instance.close();
			const records = (await readFile(join(instance.dir, "launches.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const launch = records.find((record) => record.type === "launch");
			expect(launch).toMatchObject({
				api: "cp.spawnSync",
				containment: "inherited",
				lifetime: "owned",
				origin: "kernel",
			});
			const proof = records.find((record) => record.type === "launch_proof");
			expect(Number(proof?.ackTick)).toBeLessThan(Number(proof?.invokeTick));
			expect(records.some((record) => record.type === "violation")).toBe(false);
		},
		30_000,
	);

	it("cancels a running job without killing the child", async () => {
		const { instance } = await client();
		await instance.start();
		const controller = new AbortController();
		const job = instance.run("sleep", null, controller.signal);
		controller.abort();
		await expect(job).rejects.toMatchObject({ code: "tool_child_cancelled" });
		expect(await instance.run("echo", "alive")).toBe("alive");
	}, 30_000);

	it.each([
		["hang", "ready_timeout"],
		["exit", "exited_before_ready"],
		["bad-generation", "version_mismatch"],
	])(
		"refuses a %s child with tool_child_bootstrap_failed{%s}",
		async (mode, reason) => {
			const { instance } = await client(mode, { readyMs: mode === "hang" ? 1_500 : 20_000 });
			const failure = await instance.start().catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(ToolChildError);
			expect(failure).toMatchObject({
				code: "tool_child_bootstrap_failed",
				message: expect.stringContaining(reason),
			});
			expect(instance.state).toBe("dead");
		},
		30_000,
	);

	it("rejects a job when no child is live", async () => {
		const { instance } = await client();
		await expect(instance.run("echo", 1)).rejects.toMatchObject({ code: "tool_child_unavailable" });
	});
});
