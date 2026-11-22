/**
 * `createDaemonDirectories` leaves every endpoint directory 0700. One `mkdir` just created already has
 * that mode and is not re-moded; one that existed before keeps whatever mode it was created with, so
 * it is re-moded explicitly. The flat directory may be a legacy host's and is never re-moded.
 */
import { vi } from "vitest";

const chmods = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		chmod: async (...args: Parameters<typeof actual.chmod>) => {
			chmods.paths.push(String(args[0]));
			return actual.chmod(...args);
		},
	};
});

import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonDirectories, createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";

const roots: string[] = [];

afterEach(async () => {
	chmods.paths.length = 0;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function endpointPaths(name: string) {
	const root = await mkdtemp(join(tmpdir(), `senpi-daemon-modes-${name}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	return createHostDaemonPaths({ socket: join(agentDir, "rpc", "shards", "p-0000000000000000.sock"), agentDir });
}

function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("daemon directory modes", () => {
	it("creates every endpoint directory 0700 without a chmod", async () => {
		const paths = await endpointPaths("fresh");

		await createDaemonDirectories(paths);

		for (const directory of [paths.dir, paths.generationsDir, paths.reservationsDir]) {
			expect(modeOf(directory)).toBe(0o700);
		}
		expect(chmods.paths).toEqual([]);
		expect(existsSync(paths.layoutMarker)).toBe(true);
		expect(existsSync(paths.endpointFile)).toBe(true);
	});

	it("re-modes only the directories that already existed", async () => {
		const paths = await endpointPaths("existing");
		await mkdir(paths.generationsDir, { recursive: true });
		await chmod(paths.dir, 0o755);
		await chmod(paths.generationsDir, 0o755);
		chmods.paths.length = 0;

		await createDaemonDirectories(paths);

		expect(chmods.paths.sort()).toEqual([paths.dir, paths.generationsDir].sort());
		for (const directory of [paths.dir, paths.generationsDir, paths.reservationsDir]) {
			expect(modeOf(directory)).toBe(0o700);
		}
	});

	it("never re-modes a flat directory that already existed", async () => {
		const paths = await endpointPaths("legacy");
		await mkdir(paths.flatDir, { recursive: true });
		await chmod(paths.flatDir, 0o755);
		chmods.paths.length = 0;

		await createDaemonDirectories(paths);

		expect(modeOf(paths.flatDir)).toBe(0o755);
		expect(chmods.paths).not.toContain(paths.flatDir);
		expect(modeOf(paths.dir)).toBe(0o700);
	});
});
