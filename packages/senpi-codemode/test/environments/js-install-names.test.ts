import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceKindChanges } from "../../src/environments/js-environments.ts";
import { requestedPackageName } from "../../src/environments/js-installer.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-js-names-"));
	roots.push(root);
	return root;
}

async function packageDir(parent: string, dir: string, name: string): Promise<string> {
	const path = join(parent, dir);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
	await writeFile(join(path, "index.js"), "export {};\n");
	return path;
}

/** An archive of `dir` under the top-level directory `top`, as npm (`package`) or GitHub (`<repo>-<sha>`) builds it. */
async function archive(
	parent: string,
	top: string,
	name: string,
	flags: "-czf" | "-cf",
	file: string,
): Promise<string> {
	const stage = join(parent, `stage-${top}`);
	await packageDir(stage, top, name);
	const path = join(parent, file);
	execFileSync("tar", [flags, path, "-C", stage, top]);
	return path;
}

describe("Given a spec to install", () => {
	it("When it is a local directory, then its name comes from that directory's package.json", async () => {
		const root = await scratch();
		const dir = await packageDir(root, "some-dir", "@scope/from-dir");

		expect(await requestedPackageName(dir)).toBe("@scope/from-dir");
		expect(await requestedPackageName(`file:${dir}`)).toBe("@scope/from-dir");
	});

	it.each([
		["an npm tarball", "package", "-czf", "npm-1.0.0.tgz"],
		["a GitHub-style tarball", "repo-abc123", "-czf", "repo-abc123.tgz"],
		["an uncompressed tar", "package", "-cf", "plain-1.0.0.tar"],
	] as const)(
		"When it is %s, then its name comes from the archive's own package.json",
		async (_kind, top, flags, file) => {
			const root = await scratch();
			const path = await archive(root, top, "from-archive", flags, file);

			expect(await requestedPackageName(path)).toBe("from-archive");
		},
	);

	it("When it is an archive with two top-level directories, then its name is not taken from either", async () => {
		const root = await scratch();
		const stage = join(root, "stage-two");
		await packageDir(stage, "first", "first-package");
		await packageDir(stage, "second", "second-package");
		const path = join(root, "two-tops.tgz");
		execFileSync("tar", ["-czf", path, "-C", stage, "first", "second"]);

		expect(await requestedPackageName(path)).toBeUndefined();
	});

	it("When it is an archive packed from inside its directory (entries start with ./), then its name still comes from it", async () => {
		const root = await scratch();
		const stage = join(root, "stage-dot");
		await packageDir(stage, "package", "dot-entries");
		const path = join(root, "dot-entries.tgz");
		execFileSync("tar", ["-czf", path, "-C", stage, "./package"]);

		expect(await requestedPackageName(path)).toBe("dot-entries");
	});

	it.each([
		["left-pad", "left-pad"],
		["left-pad@1.3.0", "left-pad"],
		["left-pad@^1", "left-pad"],
		["@scope/name", "@scope/name"],
		["@scope/name@2.0.0", "@scope/name"],
	])("When it is the registry spec %s, then its name is %s", async (spec, name) => {
		expect(await requestedPackageName(spec)).toBe(name);
	});

	it.each([["https://example.test/pkg-1.0.0.tgz"], ["git+https://example.test/repo.git"], ["github:user/repo"]])(
		"When it is %s, then the name is not known before the install",
		async (spec) => {
			expect(await requestedPackageName(spec)).toBeUndefined();
		},
	);
});

describe("Given a revision that installed packages from local directories", () => {
	async function revisionWith(dependencies: Record<string, string>): Promise<string> {
		const revision = join(await scratch(), "rev-1");
		await mkdir(revision, { recursive: true });
		await writeFile(join(revision, "package.json"), JSON.stringify({ dependencies }));
		return revision;
	}

	it("When the same directory is installed again, then nothing is removed first", async () => {
		const root = await scratch();
		const dir = await packageDir(root, "kept", "kept");
		const revision = await revisionWith({ kept: dir });

		expect(await sourceKindChanges(revision, [dir])).toEqual([]);
	});

	it("When the same directory is named through a link, then nothing is removed first", async () => {
		const root = await scratch();
		const dir = await packageDir(root, "real", "linked");
		execFileSync("ln", ["-s", dir, join(root, "via-link")]);
		const revision = await revisionWith({ linked: dir });

		expect(await sourceKindChanges(revision, [join(root, "via-link")])).toEqual([]);
	});

	it("When a directory package is replaced by a tarball, a registry version or another directory, then exactly that package is removed first", async () => {
		const root = await scratch();
		const swapped = await packageDir(root, "swapped", "swapped");
		const other = await packageDir(root, "other", "other");
		const moved = await packageDir(root, "moved-old", "moved");
		const movedNew = await packageDir(root, "moved-new", "moved");
		const tarball = await archive(root, "package", "swapped", "-czf", "swapped-2.0.0.tgz");
		const revision = await revisionWith({ swapped, other, moved, fromRegistry: "^1.0.0" });

		expect(await sourceKindChanges(revision, [tarball, "other@2.0.0", movedNew, "fromRegistry@2.0.0"])).toEqual([
			"swapped",
			"other",
			"moved",
		]);
	});

	it("When a tarball package is replaced by a directory, then it is removed first", async () => {
		const root = await scratch();
		const dir = await packageDir(root, "now-dir", "was-tarball");
		const revision = await revisionWith({ "was-tarball": "file:../was-tarball-1.0.0.tgz" });

		expect(await sourceKindChanges(revision, [dir])).toEqual(["was-tarball"]);
	});

	it("When a requested package is not installed yet, then nothing is removed", async () => {
		const root = await scratch();
		const dir = await packageDir(root, "fresh", "fresh");
		const revision = await revisionWith({});

		expect(await sourceKindChanges(revision, [dir, "left-pad"])).toEqual([]);
	});
});
