import * as actualFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

const injectedRace = vi.hoisted(() => ({
	lockPath: undefined as string | undefined,
	phase: undefined as Int32Array<ArrayBufferLike> | undefined,
	statePath: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		existsSync: (...args: Parameters<typeof original.existsSync>) => {
			const exists = original.existsSync(...args);
			const phase = injectedRace.phase;
			const lockPath = injectedRace.lockPath;
			const statePath = injectedRace.statePath;
			const path = args[0];
			if (
				phase !== undefined &&
				lockPath !== undefined &&
				statePath !== undefined &&
				(path === lockPath || path === statePath) &&
				Atomics.load(phase, 0) === 0
			) {
				expect(original.existsSync(lockPath)).toBe(false);
				Atomics.store(phase, 0, 1);
				Atomics.notify(phase, 0);
				expect(Atomics.wait(phase, 0, 1, 5_000)).not.toBe("timed-out");
				expect(Atomics.load(phase, 0)).toBe(2);
			}
			return exists;
		},
		readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
			const captured = original.readFileSync(...args);
			const phase = injectedRace.phase;
			if (phase !== undefined && args[0] === injectedRace.statePath && Atomics.load(phase, 0) === 2) {
				Atomics.store(phase, 0, 3);
				Atomics.notify(phase, 0);
				expect(Atomics.wait(phase, 0, 3, 5_000)).not.toBe("timed-out");
				expect(Atomics.load(phase, 0)).toBe(4);
			}
			return captured;
		},
	};
});

import { FileHookStateStorage } from "../../src/core/extensions/builtin/hooks/trust-storage.ts";

const createdDirs: string[] = [];
const workers: Worker[] = [];

function terminateWorker(worker: Worker): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out terminating the legacy hooks-state writer")), 5_000);
		worker.terminate().then(
			() => {
				clearTimeout(timeout);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

afterEach(async () => {
	injectedRace.lockPath = undefined;
	injectedRace.phase = undefined;
	injectedRace.statePath = undefined;
	await Promise.all(workers.splice(0).map(terminateWorker));
	for (const dir of createdDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks trust storage ABA recovery", () => {
	it("revalidates under writer exclusion after an absent-active-absent lock cycle", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-aba-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		const statePath = join(agentDir, "hooks-state.json");
		actualFs.mkdirSync(dirname(statePath), { recursive: true });
		actualFs.mkdirSync(cwd, { recursive: true });
		actualFs.writeFileSync(statePath, '{"version":1,"hooks":{}}\n', "utf-8");
		const expected = {
			version: 1,
			hooks: {
				legacy: {
					enabled: true,
					trustedHash: "sha256:legacy-aba",
					scope: "global",
					sourcePath: "/home/user/hooks.json",
					commandPreview: "node hooks/check.mjs",
					updatedAt: "2026-08-31T00:00:00.000Z",
				},
			},
		} as const;
		const phaseBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
		const phase = new Int32Array(phaseBuffer);
		injectedRace.lockPath = `${statePath}.lock`;
		injectedRace.phase = phase;
		injectedRace.statePath = statePath;
		const worker = new Worker(new URL("./fixtures/hooks-legacy-writer.mjs", import.meta.url), {
			workerData: {
				statePath,
				publishedState: `${JSON.stringify(expected)}\n`,
				phaseBuffer,
			},
		});
		workers.push(worker);
		const storage = new FileHookStateStorage({ agentDir, cwd });

		// When
		const state = storage.read("global");

		// Then
		expect(state).toEqual(expected);
	}, 10_000);
});
