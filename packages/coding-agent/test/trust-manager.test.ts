import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	projectAgentsSkillDirs,
} from "../src/core/trust-manager.ts";

// The real lock library, with a hook that runs the moment a store lock is acquired (the #6958 review M1 window).
const lockHooks = vi.hoisted(() => ({ acquired: undefined as (() => Promise<void> | undefined) | undefined }));
vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof import("proper-lockfile") }>();
	const real = actual.default;
	const wrapped: typeof real = {
		...real,
		lock: async (...args) => {
			const release = await real.lock(...args);
			await lockHooks.acquired?.();
			return release;
		},
		lockSync: (...args) => {
			const release = real.lockSync(...args);
			void lockHooks.acquired?.();
			return release;
		},
	};
	return { ...actual, default: wrapped };
});

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

	it("stores decisions and inherits from parent directories", async () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		await store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		await store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		await store.set(childDir, null);
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

			// Home's config dir is the user's own global config, never a project (#2465).
			writeFileSync(join(tempDir, CONFIG_DIR_NAME, "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
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

	it("asks for trust when a project codemode file sets an executable-naming setting, and only then", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			const codemode = join(configDir, "codemode.json");

			writeFileSync(codemode, JSON.stringify({ languages: { js: true, py: true } }));
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(codemode, JSON.stringify({ languages: { py: true, pyInterpreter: "/opt/repo/python" } }));
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			// Unreadable, like a project mcp.json: its presence alone asks.
			writeFileSync(codemode, "{ not json");
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

	// senpi#6951: the generation is bumped before trust.json is written, so a failed bump saves nothing.
	it("saves nothing and rejects when the generation bump fails, then releases the store lock", async () => {
		// Given a saved decision, and a directory where the bump writes its next generation
		const store = new ProjectTrustStore(agentDir);
		await store.set(cwd, true);
		const trustFile = join(agentDir, "trust.json");
		const before = readFileSync(trustFile);
		const nextGeneration = join(agentDir, "trust.json.generation.next");
		mkdirSync(join(nextGeneration, "occupied"), { recursive: true });

		// When a write cannot bump the generation
		// Then it rejects and trust.json keeps its bytes
		await expect(store.set(cwd, false)).rejects.toThrow();
		expect(readFileSync(trustFile).equals(before)).toBe(true);
		expect(store.get(cwd)).toBe(true);

		// And the store lock was released: once the bump can succeed, the next write saves
		rmSync(nextGeneration, { recursive: true });
		await store.set(cwd, false);
		expect(store.get(cwd)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"answers a synchronous read in the same process while a write holds the store lock",
		async () => {
			// Given a write that holds the store lock, parked reading a generation file nobody has written yet
			const store = new ProjectTrustStore(agentDir);
			await store.set(cwd, true);
			const generation = join(agentDir, "trust.json.generation");
			rmSync(generation);
			execFileSync("mkfifo", [generation]);
			const writing = store.set(cwd, false);
			const generationWriter = await open(generation, "w");

			// When this process reads the store meanwhile
			// Then it answers from what is saved instead of waiting for a lock its own writer holds
			expect(store.get(cwd)).toBe(true);

			// And the write completes once the generation can be read
			await generationWriter.writeFile("3\n");
			await generationWriter.close();
			await writing;
			expect(store.get(cwd)).toBe(false);
			expect(readFileSync(generation, "utf-8")).toBe("4\n");
		},
	);

	// #6958 review M1: a write's own lock must count as this process's from the moment it exists on disk.
	it("answers a synchronous read in the same process issued the moment a write acquires the store lock", async () => {
		// Given a saved decision, and a write stopped right where it has acquired the store lock
		const store = new ProjectTrustStore(agentDir);
		await store.set(cwd, true);
		const acquired = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		lockHooks.acquired = () => {
			acquired.resolve();
			return proceed.promise;
		};
		const writing = store.set(cwd, false);
		try {
			await acquired.promise;
			lockHooks.acquired = undefined;

			// When this process reads the store then
			// Then it answers from what is saved
			expect(store.get(cwd)).toBe(true);
		} finally {
			lockHooks.acquired = undefined;
			proceed.resolve();
			await writing.catch(() => undefined);
		}

		// And the write completes
		await writing;
		expect(store.get(cwd)).toBe(false);
	});

	it("lets two writes in one process wait for each other instead of failing on the lock", async () => {
		const store = new ProjectTrustStore(agentDir);
		const other = join(tempDir, "other");
		mkdirSync(other, { recursive: true });

		await Promise.all([store.set(cwd, true), store.set(other, false)]);

		expect(store.get(cwd)).toBe(true);
		expect(store.get(other)).toBe(false);
	});
});

describe("the trust walk stops below the user's home (sisyphuslabs/omo-desktop-app#2465)", () => {
	let root: string;
	let home: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		root = realpathSync(tmpdir());
		root = join(root, `trust-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		home = join(root, "home", "user");
		mkdirSync(home, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = home;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(root, { recursive: true, force: true });
	});

	it("never counts home itself, even with project-shaped config and skills there", () => {
		mkdirSync(join(home, CONFIG_DIR_NAME, "extensions"), { recursive: true });
		writeFileSync(join(home, CONFIG_DIR_NAME, "settings.json"), "{}");
		mkdirSync(join(home, ".agents", "skills"), { recursive: true });
		expect(hasTrustRequiringProjectResources(home)).toBe(false);
		mkdirSync(join(home, "code", "app"), { recursive: true });
		expect(hasTrustRequiringProjectResources(join(home, "code", "app"))).toBe(false);
	});

	it("ignores .agents/skills above home", () => {
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		mkdirSync(join(root, "home", ".agents", "skills"), { recursive: true });
		mkdirSync(join(home, "code", "app"), { recursive: true });
		expect(hasTrustRequiringProjectResources(join(home, "code", "app"))).toBe(false);
	});

	it("gives the loader and the trust check one walk: nothing at or above home", () => {
		mkdirSync(join(home, "code", "app"), { recursive: true });
		const dirs = projectAgentsSkillDirs(join(home, "code", "app"));
		expect(dirs).toEqual([join(home, "code", "app", ".agents", "skills"), join(home, "code", ".agents", "skills")]);
		expect(projectAgentsSkillDirs(home)).toEqual([]);
		expect(projectAgentsSkillDirs(root)).toEqual([]);
	});

	it("walks the folder as spelled: a link from outside home into home still counts the folders around the link", () => {
		mkdirSync(join(home, "proj"), { recursive: true });
		const shared = join(root, "shared");
		mkdirSync(join(shared, ".agents", "skills"), { recursive: true });
		symlinkSync(join(home, "proj"), join(shared, "link"));
		const cwd = join(shared, "link");
		expect(projectAgentsSkillDirs(cwd)).toContain(join(shared, ".agents", "skills"));
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("still asks for a project's own .agents/skills between the folder and home", () => {
		mkdirSync(join(home, "code", "app", ".agents", "skills"), { recursive: true });
		mkdirSync(join(home, "code", "app", "src"), { recursive: true });
		expect(hasTrustRequiringProjectResources(join(home, "code", "app", "src"))).toBe(true);
	});
});
