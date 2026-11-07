import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const injectedLocks = vi.hoisted(() => ({
	calls: 0,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
	const original = await importOriginal<{ default: typeof import("proper-lockfile") }>();
	const base = original.default;
	return {
		default: {
			...base,
			lockSync: (...args: Parameters<typeof base.lockSync>) => {
				injectedLocks.calls += 1;
				return base.lockSync(...args);
			},
		},
	};
});

import { FileHookStateStorage } from "../../../src/core/extensions/builtin/hooks/trust-storage.ts";

const createdDirs: string[] = [];

afterEach(() => {
	injectedLocks.calls = 0;
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("trust storage read without a state file (senpi#5096)", () => {
	it("takes no lock and writes nothing when the state file is absent but its directory exists", () => {
		// Given: a normal session with no trusted hooks — both state directories
		// exist, but neither holds a hooks-state.json.
		const root = mkdtempSync(join(tmpdir(), "senpi-hooks-trust-5096-"));
		createdDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		const beforeAgent = readdirSync(agentDir).sort();
		const beforeProject = readdirSync(join(cwd, ".senpi")).sort();
		const storage = new FileHookStateStorage({ agentDir, cwd });

		// When
		const globalState = storage.read("global");
		const projectState = storage.read("project");

		// Then: empty trust, and the read left no lock behind and no new files.
		expect(globalState).toEqual({ version: 1, hooks: {} });
		expect(projectState).toEqual({ version: 1, hooks: {} });
		expect(injectedLocks.calls).toBe(0);
		expect(readdirSync(agentDir).sort()).toEqual(beforeAgent);
		expect(readdirSync(join(cwd, ".senpi")).sort()).toEqual(beforeProject);
	});
});
