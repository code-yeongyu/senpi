import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, CONFIG_DIR_NAME, "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, CONFIG_DIR_NAME, "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, CONFIG_DIR_NAME, "settings.json"), { force: true });

			mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
			writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
			rmSync(join(cwd, CONFIG_DIR_NAME), { recursive: true, force: true });

			writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
			rmSync(join(cwd, "AGENTS.md"), { force: true });

			writeFileSync(join(cwd, "CLAUDE.md"), "Legacy project instructions");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
			rmSync(join(cwd, "CLAUDE.md"), { force: true });

			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("does not honour a legacy entry keyed by a path-collapsing resolution", () => {
		// Given a workspace reachable only through a symlinked parent whose link target
		// walks back up, so a path-collapsing resolver and the kernel disagree about
		// which directory the cwd actually is.
		const outside = join(tempDir, "outside");
		mkdirSync(join(outside, "subdir"), { recursive: true });
		mkdirSync(join(outside, "workspace"), { recursive: true });
		const inside = join(tempDir, "inside");
		mkdirSync(inside, { recursive: true });
		symlinkSync(join(outside, "subdir"), join(inside, "jump"), "dir");
		symlinkSync("jump/..", join(inside, "entry"), "dir");
		const reachedThroughSymlink = join(inside, "entry", "workspace");

		// And a trust store that already contains a TRUE decision under the key a
		// path-collapsing resolver would have produced for it (the pre-fix key).
		const collapsedKey = join(inside, "workspace");
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [collapsedKey]: true }, null, 2), "utf-8");

		// When the store is consulted for that workspace
		const store = new ProjectTrustStore(agentDir);
		const decision = store.get(reachedThroughSymlink);

		// Then the stale key must NOT grant trust. The kernel resolves the workspace
		// to a different directory, so the legacy entry no longer applies and the
		// user is asked again rather than silently inheriting a decision that was
		// recorded against a location this path does not occupy.
		expect(decision).not.toBe(true);
		// Control: the same store DOES honour a decision keyed by the real location,
		// so this assertion can fail rather than passing on a lookup that never matches.
		const realKey = realpathSync.native(reachedThroughSymlink);
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [realKey]: true }, null, 2), "utf-8");
		expect(new ProjectTrustStore(agentDir).get(reachedThroughSymlink)).toBe(true);
	});
});
