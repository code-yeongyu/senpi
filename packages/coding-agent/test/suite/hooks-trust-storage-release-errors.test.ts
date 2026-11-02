import * as actualFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const injectedFailures = vi.hoisted(() => ({
	cleanup: undefined as Error | undefined,
	publication: undefined as Error | undefined,
	readCallCount: 0,
	readFailure: undefined as Error | undefined,
	readFailureAt: undefined as number | undefined,
	release: undefined as Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
			injectedFailures.readCallCount += 1;
			if (injectedFailures.readCallCount === injectedFailures.readFailureAt) {
				throw injectedFailures.readFailure;
			}
			return original.readFileSync(...args);
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
				const release = base.lockSync(...args);
				return () => {
					release();
					if (injectedFailures.release !== undefined) {
						throw injectedFailures.release;
					}
				};
			},
		},
	};
});

import { FileHookStateStorage } from "../../src/core/extensions/builtin/hooks/trust-storage.ts";

const createdDirs: string[] = [];

afterEach(async () => {
	injectedFailures.cleanup = undefined;
	injectedFailures.publication = undefined;
	injectedFailures.readCallCount = 0;
	injectedFailures.readFailure = undefined;
	injectedFailures.readFailureAt = undefined;
	injectedFailures.release = undefined;
	for (const dir of createdDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks trust storage lock release failures", () => {
	it("propagates a release-only failure unchanged", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-release-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		actualFs.mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const releaseError = new Error("injected release failure");
		injectedFailures.release = releaseError;

		// When
		let thrown: unknown;
		try {
			storage.update("global", (current) => current);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			thrown = error;
		}

		// Then
		expect(thrown).toBe(releaseError);
	});

	it("preserves a reread failure unchanged when release succeeds", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-release-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		const statePath = join(agentDir, "hooks-state.json");
		actualFs.mkdirSync(dirname(statePath), { recursive: true });
		actualFs.mkdirSync(cwd, { recursive: true });
		actualFs.writeFileSync(statePath, "{ malformed", "utf-8");
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const rereadError = new Error("injected reread failure");
		injectedFailures.readCallCount = 0;
		injectedFailures.readFailure = rereadError;
		injectedFailures.readFailureAt = 2;

		// When
		let thrown: unknown;
		try {
			storage.read("global");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			thrown = error;
		}

		// Then
		expect(thrown).toBe(rereadError);
	});

	it("preserves reread failure before a simultaneous release failure", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-release-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		const statePath = join(agentDir, "hooks-state.json");
		actualFs.mkdirSync(dirname(statePath), { recursive: true });
		actualFs.mkdirSync(cwd, { recursive: true });
		actualFs.writeFileSync(statePath, "{ malformed", "utf-8");
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const rereadError = new Error("injected reread failure");
		const releaseError = new Error("injected release failure");
		injectedFailures.readCallCount = 0;
		injectedFailures.readFailure = rereadError;
		injectedFailures.readFailureAt = 2;
		injectedFailures.release = releaseError;

		// When
		let thrown: unknown;
		try {
			storage.read("global");
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			thrown = error;
		}

		// Then
		expect(thrown).toBeInstanceOf(AggregateError);
		expect(thrown).toMatchObject({ errors: [rereadError, releaseError] });
	});

	it("flattens publication and cleanup failures before a simultaneous release failure", async () => {
		// Given
		const root = await mkdtemp(join(tmpdir(), "senpi-hooks-trust-release-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		actualFs.mkdirSync(cwd, { recursive: true });
		const storage = new FileHookStateStorage({ agentDir, cwd });
		const publicationError = new Error("injected publication failure");
		const cleanupError = new Error("injected cleanup failure");
		const releaseError = new Error("injected release failure");
		injectedFailures.publication = publicationError;
		injectedFailures.cleanup = cleanupError;
		injectedFailures.release = releaseError;

		// When
		let thrown: unknown;
		try {
			storage.update("global", (current) => current);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			thrown = error;
		}

		// Then
		expect(thrown).toBeInstanceOf(AggregateError);
		expect(thrown).toMatchObject({ errors: [publicationError, cleanupError, releaseError] });
	});
});
