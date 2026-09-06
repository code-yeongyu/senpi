import * as actualFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";

const injectedFailures = vi.hoisted(() => ({
	chmod: undefined as Error | undefined,
	cleanup: undefined as Error | undefined,
	lockOptions: [] as unknown[],
	publication: undefined as Error | undefined,
	readCaptured: undefined as (() => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		chmodSync: (...args: Parameters<typeof original.chmodSync>) => {
			if (injectedFailures.chmod !== undefined) {
				throw injectedFailures.chmod;
			}
			return original.chmodSync(...args);
		},
		readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
			const captured = original.readFileSync(...args);
			const readCaptured = injectedFailures.readCaptured;
			if (readCaptured !== undefined) {
				injectedFailures.readCaptured = undefined;
				readCaptured();
			}
			return captured;
		},
		renameSync: (...args: Parameters<typeof original.renameSync>) => {
			if (injectedFailures.publication !== undefined) {
				throw injectedFailures.publication;
			}
			return original.renameSync(...args);
		},
		rmSync: (...args: Parameters<typeof original.rmSync>) => {
			if (injectedFailures.cleanup !== undefined) {
				throw injectedFailures.cleanup;
			}
			return original.rmSync(...args);
		},
	};
});

vi.mock("proper-lockfile", async (importOriginal) => {
	const original = await importOriginal<{ default: typeof import("proper-lockfile") }>();
	const base = original.default;
	return {
		default: {
			...base,
			lockSync: (...args: Parameters<typeof base.lockSync>) => {
				injectedFailures.lockOptions.push(args[1]);
				return base.lockSync(...args);
			},
		},
	};
});

import { FileHookStateStorage } from "../../src/core/extensions/builtin/hooks/trust-storage.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	injectedFailures.chmod = undefined;
	injectedFailures.publication = undefined;
	injectedFailures.cleanup = undefined;
	injectedFailures.lockOptions.length = 0;
	injectedFailures.readCaptured = undefined;
	for (const dir of createdDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks trust storage failures", () => {
	it("re-reads malformed bytes captured while a legacy writer held the lock", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		const statePath = join(agentDir, "hooks-state.json");
		actualFs.mkdirSync(dirname(statePath), { recursive: true });
		actualFs.mkdirSync(cwd, { recursive: true });
		actualFs.writeFileSync(statePath, "", "utf-8");
		const expected = {
			version: 1,
			hooks: {
				legacy: {
					enabled: true,
					trustedHash: "sha256:legacy",
					scope: "global",
					sourcePath: "/home/user/hooks.json",
					commandPreview: "node hooks/check.mjs",
					updatedAt: "2026-08-31T00:00:00.000Z",
				},
			},
		} as const;
		const release = lockfile.lockSync(dirname(statePath), {
			realpath: false,
			lockfilePath: `${statePath}.lock`,
		});
		let lockHeld = true;
		injectedFailures.readCaptured = () => {
			actualFs.writeFileSync(statePath, `${JSON.stringify(expected)}\n`, "utf-8");
			release();
			lockHeld = false;
		};
		const storage = new FileHookStateStorage({ agentDir, cwd });

		try {
			// When
			const state = storage.read("global");

			// Then
			expect(state).toEqual(expected);
		} finally {
			if (lockHeld) {
				release();
			}
		}
	}, 10_000);

	it("keeps a malformed unlocked snapshot fail-closed", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		const statePath = join(agentDir, "hooks-state.json");
		actualFs.mkdirSync(dirname(statePath), { recursive: true });
		actualFs.mkdirSync(cwd, { recursive: true });
		actualFs.writeFileSync(statePath, "{ malformed", "utf-8");
		const storage = new FileHookStateStorage({ agentDir, cwd });

		// When
		const state = storage.read("global");

		// Then
		expect(state).toEqual({ version: 1, hooks: {} });
	});

	it("bounds malformed snapshot retries while the writer lock remains active", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		const statePath = join(agentDir, "hooks-state.json");
		actualFs.mkdirSync(dirname(statePath), { recursive: true });
		actualFs.mkdirSync(cwd, { recursive: true });
		actualFs.writeFileSync(statePath, "", "utf-8");
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const release = lockfile.lockSync(dirname(statePath), {
			realpath: false,
			lockfilePath: `${statePath}.lock`,
		});
		injectedFailures.lockOptions.length = 0;

		try {
			// When
			const state = storage.read("global");

			// Then
			expect(state).toEqual({ version: 1, hooks: {} });
			expect(injectedFailures.lockOptions).toHaveLength(10);
			expect(injectedFailures.lockOptions).toEqual(
				Array.from({ length: 10 }, () => ({ realpath: false, lockfilePath: `${statePath}.lock` })),
			);
		} finally {
			release();
		}
	}, 10_000);

	it("preserves publication and cleanup failures in order", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		actualFs.mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const publicationError = new Error("injected publication failure");
		const cleanupError = new Error("injected cleanup failure");
		injectedFailures.publication = publicationError;
		injectedFailures.cleanup = cleanupError;

		// When
		let thrown: unknown;
		try {
			storage.update("global", (current) => current);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			thrown = error;
		}

		// Then
		expect(thrown).toBeInstanceOf(AggregateError);
		expect(thrown).toMatchObject({
			message: "Failed to publish and clean up hook trust state snapshot",
			errors: [publicationError, cleanupError],
		});
	});

	it("preserves chmod and cleanup failures in order", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		actualFs.mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const chmodError = new Error("injected chmod failure");
		const cleanupError = new Error("injected cleanup failure");
		injectedFailures.chmod = chmodError;
		injectedFailures.cleanup = cleanupError;

		// When
		let thrown: unknown;
		try {
			storage.update("global", (current) => current);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			thrown = error;
		}

		// Then
		expect(thrown).toBeInstanceOf(AggregateError);
		expect(thrown).toMatchObject({
			message: "Failed to publish and clean up hook trust state snapshot",
			errors: [chmodError, cleanupError],
		});
	});

	it("preserves the original publication error when cleanup succeeds", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-errors-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		actualFs.mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const publicationError = new Error("injected publication failure");
		injectedFailures.publication = publicationError;

		// When
		let thrown: unknown;
		try {
			storage.update("global", (current) => current);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			thrown = error;
		}

		// Then
		expect(thrown).toBe(publicationError);
	});
});
