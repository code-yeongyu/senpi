import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostCrashCleanupPaths } from "../src/modes/rpc/host-cleanup-paths.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	type HostDaemonPaths,
} from "../src/modes/rpc/host-daemon-paths.ts";
import {
	clearHostRegistration,
	releaseGeneration,
	writeHostRegistration,
} from "../src/modes/rpc/host-daemon-registration.ts";
import { cleanupWatchdogPaths } from "../src/modes/rpc/host-watchdog.ts";

// senpi#2241: the registration pointer is what every reader takes as "a host is registered here",
// so a leaving generation removes it only after the state it describes. The removals are recorded
// through the real fs functions, which still run.
const removals = vi.hoisted(() => ({ paths: [] as string[], events: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
			removals.paths.push(String(path));
			removals.events.push(`start ${String(path)}`);
			await actual.rm(path, options);
			removals.events.push(`end ${String(path)}`);
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		rmSync: (path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
			removals.paths.push(String(path));
			removals.events.push(`start ${String(path)}`);
			actual.rmSync(path, options);
			removals.events.push(`end ${String(path)}`);
		},
	};
});

const roots: string[] = [];

afterEach(() => {
	removals.paths.length = 0;
	removals.events.length = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-teardown-"));
	roots.push(root);
	return root;
}

async function registeredDaemon(instanceId: string): Promise<HostDaemonPaths> {
	const root = scratch();
	const socket = join(root, "rpc.sock");
	const paths = createHostDaemonPaths({ socket, agentDir: join(root, "agent") });
	await createDaemonDirectories(paths);
	writeFileSync(paths.settingsFile, "{}");
	await writeHostRegistration(paths, {
		record: { pid: process.pid, processStartTime: null },
		socket,
		instanceId,
		generation: 0,
		launchProfileId: "teardown-order",
	});
	removals.paths.length = 0;
	return paths;
}

describe("host teardown removes the registration pointer last", () => {
	const targets = {
		pointerFile: "/d/pointer.json",
		generationPidFile: "/d/generations/a/host.pid",
		settingsFile: "/d/settings.json",
		publicSocket: "/d/rpc.sock",
	};

	it("orders the crash-path cleanup list with the pointer last on every platform", () => {
		expect(hostCrashCleanupPaths({ ...targets, successor: false, platform: "linux" })).toEqual([
			"/d/generations/a/host.pid",
			"/d/settings.json",
			"/d/pointer.json",
		]);
		expect(hostCrashCleanupPaths({ ...targets, successor: false, platform: "win32" })).toEqual([
			"/d/generations/a/host.pid",
			"/d/settings.json",
			"/d/rpc.sock",
			"/d/pointer.json",
		]);
	});

	it("leaves a successor's crash path nothing of the registration it replaces", () => {
		expect(hostCrashCleanupPaths({ ...targets, successor: true, platform: "linux" })).toEqual([]);
		expect(hostCrashCleanupPaths({ ...targets, successor: true, platform: "win32" })).toEqual(["/d/rpc.sock"]);
	});

	it("the watchdog cleanup removes its paths one at a time in list order", async () => {
		const root = scratch();
		const paths = ["first", "second", "third"].map((name) => join(root, name));
		for (const path of paths) writeFileSync(path, name(path));
		const scratchDir = join(root, "scratch");
		await cleanupWatchdogPaths({ cleanupPaths: paths, scratchDir });
		// Each removal finishes before the next one starts.
		expect(removals.events).toEqual([...paths, scratchDir].flatMap((path) => [`start ${path}`, `end ${path}`]));
		expect(paths.filter((path) => existsSync(path))).toEqual([]);
	});

	it("a leaving generation removes settings and its generation before the pointer", async () => {
		const paths = await registeredDaemon("gen-a");
		await releaseGeneration(paths, { instanceId: "gen-a", pid: process.pid });
		expect(removals.paths.at(-1)).toBe(paths.pointerFile);
		expect(removals.paths).toContain(paths.settingsFile);
		expect(existsSync(paths.pointerFile)).toBe(false);
		expect(existsSync(paths.settingsFile)).toBe(false);
	});

	it("clearing a registration removes the pointer last", async () => {
		const paths = await registeredDaemon("gen-b");
		await clearHostRegistration(paths);
		expect(removals.paths.at(-1)).toBe(paths.pointerFile);
		expect(removals.paths).toContain(paths.settingsFile);
		expect(existsSync(paths.pointerFile)).toBe(false);
	});
});

function name(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
