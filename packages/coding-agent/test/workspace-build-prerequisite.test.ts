import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertStaleWorkspacePackages,
	assertWorkspaceBuildPrerequisite,
	findStaleWorkspacePackages,
	findUnbuiltWorkspaceSpecifiers,
	isWorkspacePackageStale,
} from "./support/workspace-build-prerequisite.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FAKE_PACKAGES: Record<string, readonly string[]> = {
	"@earendil-works/pi-ai": [".", "./compat", "./providers/cursor"],
	"@earendil-works/pi-tui": ["."],
	"@earendil-works/pi-agent-core": [".", "./node"],
};

/** Writes a built-looking copy of every child-process workspace package under `packagesDir/<name>`. */
function writeBuiltPackages(packagesDir: string): void {
	for (const [name, subpaths] of Object.entries(FAKE_PACKAGES)) {
		const root = join(packagesDir, name);
		const exports: Record<string, { import: string }> = {};
		for (const subpath of subpaths) {
			const file = `./dist/${subpath === "." ? "index" : subpath.slice(2).replaceAll("/", "-")}.js`;
			exports[subpath] = { import: file };
			mkdirSync(join(root, "dist"), { recursive: true });
			writeFileSync(join(root, file), "export {};\n");
		}
		writeFileSync(join(root, "package.json"), JSON.stringify({ name, type: "module", exports }));
	}
}

/**
 * A module URL outside the monorepo. Its parent folder carries a built-looking copy of every
 * workspace package, the way `~/node_modules` can on a developer machine: Node's resolver climbs
 * into it, so only the checkout boundary keeps these specifiers unresolved (senpi#3482).
 */
function outsideWorkspaceModuleUrl(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-workspace-prereq-"));
	tempDirs.push(dir);
	writeBuiltPackages(join(dir, "node_modules"));
	const probeDir = join(dir, "outside");
	mkdirSync(probeDir);
	return pathToFileURL(join(probeDir, "probe.mjs")).href;
}

describe("workspace build prerequisite", () => {
	it("reports every child-process specifier as unresolvable outside the workspace", () => {
		const missing = findUnbuiltWorkspaceSpecifiers(outsideWorkspaceModuleUrl());

		expect(missing).toEqual([
			"@earendil-works/pi-ai",
			"@earendil-works/pi-ai/compat",
			"@earendil-works/pi-ai/providers/cursor",
			"@earendil-works/pi-tui",
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-agent-core/node",
		]);
	});

	it("names the unmet specifiers and the remedy when the prerequisite fails", () => {
		const probe = outsideWorkspaceModuleUrl();

		expect(() => assertWorkspaceBuildPrerequisite(probe)).toThrowError(/@earendil-works\/pi-agent-core\/node/);
		expect(() => assertWorkspaceBuildPrerequisite(probe)).toThrowError(/npm run build/);
	});

	it("accepts a linked worktree whose node_modules links each package to another checkout's built copy", () => {
		// A git worktree that links the main checkout's packages resolves outside its own tree;
		// those links still count as built (senpi#3482).
		const dir = mkdtempSync(join(tmpdir(), "pi-workspace-linked-"));
		tempDirs.push(dir);
		const mainPackages = join(dir, "main-checkout", "node_modules");
		writeBuiltPackages(mainPackages);
		const worktree = join(dir, "worktree");
		const probeDir = join(worktree, "packages", "coding-agent", "test");
		mkdirSync(probeDir, { recursive: true });
		mkdirSync(join(worktree, "node_modules", "@earendil-works"), { recursive: true });
		writeFileSync(join(worktree, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
		for (const name of Object.keys(FAKE_PACKAGES)) {
			symlinkSync(join(mainPackages, name), join(worktree, "node_modules", name), "junction");
		}

		expect(findUnbuiltWorkspaceSpecifiers(pathToFileURL(join(probeDir, "probe.mjs")).href)).toEqual([]);
	});

	it("tells a nested worktree without node_modules to install, not to build", () => {
		// A worktree nested in the main checkout (main/.worktrees/x) with no node_modules of its own
		// resolves the main checkout's packages from outside itself: unmet, and the remedy is an install
		// in that worktree, which a build would not fix (senpi#3482).
		const dir = mkdtempSync(join(tmpdir(), "pi-workspace-nested-"));
		tempDirs.push(dir);
		writeBuiltPackages(join(dir, "node_modules"));
		writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
		const nested = join(dir, ".worktrees", "feature");
		const probeDir = join(nested, "packages", "coding-agent", "test");
		mkdirSync(probeDir, { recursive: true });
		writeFileSync(join(nested, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
		const probe = pathToFileURL(join(probeDir, "probe.mjs")).href;

		expect(() => assertWorkspaceBuildPrerequisite(probe)).toThrowError(/has no node_modules of its own/);
		expect(() => assertWorkspaceBuildPrerequisite(probe)).toThrowError(/bun install/);
		expect(() => assertWorkspaceBuildPrerequisite(probe)).not.toThrowError(/npm run build/);
	});

	it("passes for this suite, whose child processes require the built entrypoints", () => {
		// This is the live prerequisite: it holds exactly when the workspace is built,
		// which is what the spawned-CLI and worker tests in this suite depend on.
		expect(findUnbuiltWorkspaceSpecifiers(import.meta.url)).toEqual([]);
		expect(() => assertWorkspaceBuildPrerequisite(import.meta.url)).not.toThrow();
	});
});

describe("workspace dist freshness", () => {
	function makePackage(sourceMtimeMs: number, distMtimeMs: number, distFiles = true): string {
		const root = mkdtempSync(join(tmpdir(), "pi-workspace-freshness-"));
		tempDirs.push(root);
		const pkg = join(root, "fake-pkg");
		mkdirSync(join(pkg, "src"), { recursive: true });
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "src", "index.ts"), "export {};\n");
		if (distFiles) writeFileSync(join(pkg, "dist", "index.js"), "export {};\n");
		// Pin every file's mtime explicitly: fixture timestamps, not wall clock.
		const pin = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));
		pin(join(pkg, "src", "index.ts"), sourceMtimeMs);
		if (distFiles) pin(join(pkg, "dist", "index.js"), distMtimeMs);
		return pkg;
	}

	it("flags a package whose dist predates its newest source file", () => {
		const pkg = makePackage(2_000, 1_000);
		expect(isWorkspacePackageStale(pkg)).toEqual({ stale: true, srcNewestMs: 2_000, distNewestMs: 1_000 });
	});

	it("accepts a package whose dist is at least as new as its sources", () => {
		const pkg = makePackage(1_000, 2_000);
		expect(isWorkspacePackageStale(pkg).stale).toBe(false);
	});

	it("reports an empty dist as stale (unbuilt output)", () => {
		const pkg = makePackage(1_000, 1_000, false);
		expect(isWorkspacePackageStale(pkg).stale).toBe(true);
	});

	it("assertWorkspaceBuildPrerequisite names the stale package and the remedy", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-workspace-freshness-"));
		tempDirs.push(root);
		const pkg = join(root, "fake-pkg");
		mkdirSync(join(pkg, "src"), { recursive: true });
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "src", "index.ts"), "export {};\n");
		writeFileSync(join(pkg, "dist", "index.js"), "export {};\n");
		const pin = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));
		pin(join(pkg, "src", "index.ts"), 2_000);
		pin(join(pkg, "dist", "index.js"), 1_000);
		const run = () => assertStaleWorkspacePackages([{ name: "fake-pkg", rootDir: pkg }]);
		expect(run).toThrowError(/fake-pkg/);
		expect(run).toThrowError(/npm run build/);
	});

	it("this live workspace is fresh right after a build", () => {
		// Live prerequisite: the repository that owns this suite must not carry a
		// dist older than its sources, or every spawned-child test dies at import.
		expect(findStaleWorkspacePackages(import.meta.url)).toEqual([]);
	});
});
