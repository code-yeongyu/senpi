// senpi#4230: exercise the real engine role and owner pipe without a Windows VM.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { processIsRunning } from "../../../utils/process-identity.ts";
import { prepareManagedLaunch } from "./managed-launch-process.ts";
import { MANAGED_LAUNCH_MARKER_ENV } from "./managed-tree.ts";
import { SessionLaunchSupervisor } from "./session-launch-supervisor.ts";

// One child in its own session (`detached: true` calls setsid) and one ordinary child; the command then exits.
const SPAWN_TWO_CHILDREN = `
const { spawn } = require("node:child_process");
const forever = ["-e", "setInterval(() => {}, 1000)"];
const detached = spawn(process.execPath, forever, { detached: true, stdio: "ignore" });
const ordinary = spawn(process.execPath, forever, { stdio: "ignore" });
require("node:fs").writeFileSync(process.env.PIDS_FILE, JSON.stringify({ detached: detached.pid, ordinary: ordinary.pid }));
process.exit(0);
`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "managed-process-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return {
		dir,
		command: {
			command: process.execPath,
			args: ["-e", 'process.stdout.write("ran"); process.exit(0)'],
			cwd: dir,
			env: process.env,
			logPath: join(dir, "command.log"),
		},
	};
}

describe.skipIf(process.platform === "win32")("managed foreground process on POSIX", () => {
	it("does not execute user code before containment admission releases it", async () => {
		const { dir, command } = await setup();
		const owner = new SessionLaunchSupervisor({
			dir,
			prepare: async (spec) => {
				const held = await prepareManagedLaunch(spec);
				try {
					expect(await readFile(spec.logPath, "utf8")).toBe("");
					return held;
				} catch (error) {
					await held.close();
					throw error;
				}
			},
		});
		cleanup.push(() => owner.close());

		const launch = await owner.start(command, "fixture-command");
		await expect(launch.completed).resolves.toBe(0);
		expect(await readFile(command.logPath, "utf8")).toBe("ran");
	}, 15_000);

	async function twoChildren(dir: string, logPath: string) {
		const pidsFile = join(dir, "pids.json");
		const command = {
			command: process.execPath,
			args: ["-e", SPAWN_TWO_CHILDREN],
			cwd: dir,
			env: { ...process.env, PIDS_FILE: pidsFile },
			logPath,
		};
		const read = async (): Promise<number[]> => {
			const { detached, ordinary } = JSON.parse(await readFile(pidsFile, "utf8")) as Record<string, number>;
			const pids = [detached ?? -1, ordinary ?? -1];
			cleanup.push(async () => {
				for (const pid of pids) if (processIsRunning(pid)) process.kill(pid, "SIGKILL");
			});
			return pids;
		};
		return { command, read };
	}

	it("ends a descendant that started its own session when the session closes", async () => {
		const { dir, command: base } = await setup();
		const { command, read } = await twoChildren(dir, base.logPath);
		const owner = new SessionLaunchSupervisor({ dir });
		cleanup.push(() => owner.close());
		const launch = await owner.start(command, "call-a");
		await expect(launch.completed).resolves.toBe(0);
		const pids = await read();
		expect(pids.map(processIsRunning)).toEqual([true, true]);

		await owner.close();

		expect(pids.map(processIsRunning)).toEqual([false, false]);
	}, 20_000);

	it("ends a descendant that started its own session when the owner pipe is lost", async () => {
		const { dir, command: base } = await setup();
		const { command, read } = await twoChildren(dir, base.logPath);
		const held = await prepareManagedLaunch({
			...command,
			env: { ...command.env, [MANAGED_LAUNCH_MARKER_ENV]: randomUUID() },
		});
		cleanup.push(() => held.close());
		await held.release();
		await expect(held.completed).resolves.toBe(0);
		const pids = await read();
		expect(pids.map(processIsRunning)).toEqual([true, true]);

		await held.close();

		expect(pids.map(processIsRunning)).toEqual([false, false]);
	}, 20_000);

	it("keeps the foreground service alive after start returns and ends it on session close", async () => {
		const { dir, command } = await setup();
		const owner = new SessionLaunchSupervisor({ dir });
		cleanup.push(() => owner.close());
		const launch = await owner.start(
			{ ...command, args: ["-e", 'require("node:net").createServer().listen(0)'] },
			"service:fixture",
		);
		expect(() => process.kill(launch.pid, 0)).not.toThrow();

		await owner.close();

		await expect(launch.completed).resolves.not.toBe(0);
		expect(() => process.kill(launch.pid, 0)).toThrow();
	}, 15_000);
});
