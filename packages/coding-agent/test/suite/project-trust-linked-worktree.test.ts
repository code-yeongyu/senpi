/**
 * A linked git worktree inherits the project-trust decision of its repository's main checkout.
 * Tools that run one agent per worktree (Orca's `~/orca/workspaces/<repo>/<name>`) put the worktree
 * outside the main checkout, so before this every new worktree of a trusted repository stopped at
 * "Trust project folder?" before its first turn. The fixtures write exactly the files
 * `git worktree add` writes (no git is spawned, as the trust store spawns none either).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import type { ProjectTrustContext } from "../../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../../src/core/project-trust.ts";
import { getSavedProjectTrust, ProjectTrustStore } from "../../src/core/trust-manager.ts";

let scratch: string;
let store: ProjectTrustStore;

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "senpi-worktree-trust-")));
	mkdirSync(join(scratch, "home"), { recursive: true });
	vi.stubEnv("HOME", join(scratch, "home"));
	mkdirSync(join(scratch, "agent"), { recursive: true });
	store = new ProjectTrustStore(join(scratch, "agent"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

interface LinkedWorktree {
	readonly main: string;
	readonly worktree: string;
	readonly admin: string;
}

/** A main checkout at `projects/repo/` and a linked worktree outside it, as `git worktree add` lays them out. */
function linkedWorktree(name = "wt"): LinkedWorktree {
	const main = join(scratch, "projects", "repo");
	const worktree = join(scratch, "workspaces", "repo", name);
	const admin = join(main, ".git", "worktrees", name);
	mkdirSync(admin, { recursive: true });
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(admin, "HEAD"), `ref: refs/heads/${name}\n`);
	writeFileSync(join(admin, "commondir"), "../..\n");
	writeFileSync(join(admin, "gitdir"), `${join(worktree, ".git")}\n`);
	writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
	return { main, worktree, admin };
}

function promptSpy(): { context: ProjectTrustContext; prompts: string[] } {
	const prompts: string[] = [];
	const context: ProjectTrustContext = {
		cwd: "",
		mode: "tui",
		hasUI: true,
		ui: {
			select: async (title) => {
				prompts.push(title);
				return undefined;
			},
			confirm: () => Promise.reject(new Error("the trust prompt uses select")),
			input: () => Promise.reject(new Error("the trust prompt uses select")),
			notify: () => {},
		},
	};
	return { context, prompts };
}

describe("a linked git worktree inherits its main checkout's project trust", () => {
	it("a worktree of a trusted main checkout is trusted, and so is a folder inside it", async () => {
		const { main, worktree } = linkedWorktree();
		mkdirSync(join(worktree, "packages", "app"), { recursive: true });
		store.set(main, true);

		expect(await getSavedProjectTrust(store, worktree)).toBe(true);
		expect(await getSavedProjectTrust(store, join(worktree, "packages", "app"))).toBe(true);
	});

	it("a worktree of an untrusted main checkout is untrusted", async () => {
		const { main, worktree } = linkedWorktree();
		store.set(main, false);

		expect(await getSavedProjectTrust(store, worktree)).toBe(false);
	});

	it("a main checkout under a trusted parent folder passes that trust on", async () => {
		const { worktree } = linkedWorktree();
		store.set(join(scratch, "projects"), true);

		expect(await getSavedProjectTrust(store, worktree)).toBe(true);
	});

	it("a decision saved for the worktree, or a folder above it, wins over the main checkout", async () => {
		const { main, worktree } = linkedWorktree();
		store.set(main, true);
		store.set(worktree, false);
		expect(await getSavedProjectTrust(store, worktree)).toBe(false);

		store.set(worktree, null);
		store.set(join(scratch, "workspaces"), false);
		expect(await getSavedProjectTrust(store, worktree)).toBe(false);
	});

	it("an undecided main checkout leaves the worktree undecided", async () => {
		const { worktree } = linkedWorktree();

		expect(await getSavedProjectTrust(store, worktree)).toBeNull();
	});

	it("a worktree whose admin directory does not point back at it inherits nothing", async () => {
		const { main, worktree, admin } = linkedWorktree();
		store.set(main, true);
		expect(await getSavedProjectTrust(store, worktree)).toBe(true);
		writeFileSync(join(admin, "gitdir"), `${join(scratch, "elsewhere", ".git")}\n`);

		expect(await getSavedProjectTrust(store, worktree)).toBeNull();
	});

	it("a submodule-style gitdir without a commondir inherits nothing", async () => {
		const { main, worktree, admin } = linkedWorktree();
		store.set(main, true);
		expect(await getSavedProjectTrust(store, worktree)).toBe(true);
		rmSync(join(admin, "commondir"));

		expect(await getSavedProjectTrust(store, worktree)).toBeNull();
	});

	it("a worktree of a bare or separate-git-dir repository inherits nothing", async () => {
		const commonDir = join(scratch, "store.git");
		const admin = join(commonDir, "worktrees", "wt");
		const worktree = join(scratch, "workspaces", "store", "wt");
		mkdirSync(admin, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(admin, "commondir"), "../..\n");
		writeFileSync(join(admin, "gitdir"), `${join(worktree, ".git")}\n`);
		writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
		store.set(commonDir, true);

		expect(await getSavedProjectTrust(store, worktree)).toBeNull();
	});

	it("a main checkout whose .git is not the common dir is not trusted through it", async () => {
		const { main, worktree } = linkedWorktree();
		store.set(main, true);
		expect(await getSavedProjectTrust(store, worktree)).toBe(true);
		rmSync(join(main, ".git"), { recursive: true });
		writeFileSync(join(main, ".git"), "gitdir: /somewhere/else\n");

		expect(await getSavedProjectTrust(store, worktree)).toBeNull();
	});

	it.each([
		["an absolute", true],
		["a relative", false],
	])(
		"a folder outside the repository whose own admin dir names a trusted repository's .git through %s commondir is not trusted",
		async (_label, absolute) => {
			const { main, worktree } = linkedWorktree();
			store.set(main, true);
			expect(await getSavedProjectTrust(store, worktree)).toBe(true);
			const outside = join(scratch, "downloads", "archive");
			const admin = join(scratch, "downloads", "admin", "wt");
			mkdirSync(admin, { recursive: true });
			mkdirSync(join(outside, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(join(outside, CONFIG_DIR_NAME, "settings.json"), "{}");
			const commonDir = join(main, ".git");
			writeFileSync(join(admin, "commondir"), `${absolute ? commonDir : relative(admin, commonDir)}\n`);
			writeFileSync(join(admin, "gitdir"), `${join(outside, ".git")}\n`);
			writeFileSync(join(outside, ".git"), `gitdir: ${admin}\n`);

			const spy = promptSpy();
			await expect(
				resolveProjectTrusted({ cwd: outside, trustStore: store, projectTrustContext: spy.context }),
			).resolves.toBe(false);
			expect(spy.prompts).toHaveLength(1);
		},
	);

	it("a worktree created with relative paths inherits, also when its .git file reaches the admin dir through a symlink", async () => {
		const realProjects = join(scratch, "deep", "nested", "projects");
		const main = join(realProjects, "repo");
		const admin = join(main, ".git", "worktrees", "wt");
		const worktree = join(scratch, "workspaces", "repo", "wt");
		mkdirSync(admin, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		symlinkSync(realProjects, join(scratch, "projects"));
		writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
		// `git worktree add --relative-paths` writes every pointer relative to the real directories.
		writeFileSync(join(admin, "commondir"), "../..\n");
		writeFileSync(join(admin, "gitdir"), `${relative(admin, join(worktree, ".git"))}\n`);
		const linkedAdmin = join(scratch, "projects", "repo", ".git", "worktrees", "wt");
		writeFileSync(join(worktree, ".git"), `gitdir: ${relative(worktree, linkedAdmin)}\n`);
		store.set(main, true);

		expect(await getSavedProjectTrust(store, worktree)).toBe(true);
	});

	it("starting in a worktree of a trusted repository does not ask, and an untrusted one still asks", async () => {
		const { main, worktree } = linkedWorktree();
		mkdirSync(join(worktree, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(worktree, CONFIG_DIR_NAME, "settings.json"), "{}");

		const untrusted = promptSpy();
		await expect(
			resolveProjectTrusted({ cwd: worktree, trustStore: store, projectTrustContext: untrusted.context }),
		).resolves.toBe(false);
		expect(untrusted.prompts).toHaveLength(1);

		store.set(main, true);
		const trusted = promptSpy();
		await expect(
			resolveProjectTrusted({ cwd: worktree, trustStore: store, projectTrustContext: trusted.context }),
		).resolves.toBe(true);
		expect(trusted.prompts).toEqual([]);
	});
});
