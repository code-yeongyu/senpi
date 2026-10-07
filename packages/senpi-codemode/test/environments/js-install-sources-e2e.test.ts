import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

const probeSource = 'export const probe = () => "ok";\n';
const cleanupDirs: string[] = [];

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function packageDir(parent: string, name: string, source: string): Promise<string> {
	const dir = join(parent, `${name}-dir`);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
	);
	await writeFile(join(dir, "index.js"), source);
	return dir;
}

/** Every file below `dir` with its contents, links reported as such, so a write through any link shows up. */
function tree(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			const stats = lstatSync(path);
			if (stats.isSymbolicLink()) files[relative(dir, path)] = "<link>";
			else if (stats.isDirectory()) walk(path);
			else files[relative(dir, path)] = readFileSync(path, "utf8");
		}
	};
	walk(dir);
	return files;
}

function activeBase(root: string): string {
	return join(root, "artifacts", "environments", "js", "test");
}

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a package installed from a local directory", () => {
	it.each([["npm"], ["bun"]] as const)(
		"When %s installs from a directory and then installs another package, then both import and the source directory is untouched",
		async (installer) => {
			const { fixtures, run } = await session(installer);
			const source = await packageDir(fixtures, "senpi-dir-probe", 'export const fromDir = () => "dir";\n');
			const tarball = await packFixture(fixtures, "senpi-after-dir", "1.0.0", probeSource);
			const before = tree(source);

			const first = await run(`%${installer} add ${source}`);
			const second = await run(`%${installer} add ${tarball}`);
			const imported = await run(
				'const { fromDir } = await import("senpi-dir-probe");\nconst { probe } = await import("senpi-after-dir");\nfromDir() + " " + probe()',
			);

			expect(textOf(first)).toContain(`added senpi-dir-probe with ${installer}`);
			expect(second.details).not.toHaveProperty("isError", true);
			expect(textOf(imported)).toContain("dir ok");
			expect(tree(source)).toEqual(before);
		},
		240_000,
	);

	it.each([["npm"], ["bun"]] as const)(
		"When %s replaces a directory install with a same-name tarball and then installs again, then the import gets the tarball and the directory is untouched",
		async (installer) => {
			const { fixtures, run } = await session(installer);
			const source = await packageDir(fixtures, "senpi-dir-swap", 'export const which = () => "dir";\n');
			const tarball = await packFixture(
				fixtures,
				"senpi-dir-swap",
				"2.0.0",
				'export const which = () => "tarball";\n',
			);
			const later = await packFixture(fixtures, "senpi-dir-swap-later", "1.0.0", probeSource);
			const before = tree(source);

			await run(`%${installer} add ${source}`);
			const replaced = await run(`%${installer} add ${tarball}`);
			const third = await run(`%${installer} add ${later}`);
			const imported = await run('const { which } = await import("senpi-dir-swap");\nwhich()');

			expect(replaced.details).not.toHaveProperty("isError", true);
			expect(third.details).not.toHaveProperty("isError", true);
			expect(textOf(imported).trim()).toBe('"tarball"');
			expect(tree(source)).toEqual(before);
		},
		240_000,
	);

	it("When bun replaces a directory install with a same-name tarball from a URL, then the stale links are refused before publishing and the previous revision stays usable", async () => {
		const { root, fixtures, run } = await session("bun");
		const source = await packageDir(fixtures, "senpi-url-swap", 'export const which = () => "dir";\n');
		const tarball = await packFixture(fixtures, "senpi-url-swap", "2.0.0", 'export const which = () => "tarball";\n');
		const later = await packFixture(fixtures, "senpi-url-later", "1.0.0", probeSource);
		// A URL names no package before the install, so nothing is removed first and only the post-build check stands
		// between bun's leftover links (#2758) and the next revision.
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/octet-stream" });
			response.end(readFileSync(tarball));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as AddressInfo;
			await run(`%bun add ${source}`);
			const active = (await readActiveRevision(activeBase(root)))?.dir ?? "";
			const before = tree(active);

			const swap = await run(`%bun add http://127.0.0.1:${port}/senpi-url-swap-2.0.0.tgz`);
			const imported = await run('const { which } = await import("senpi-url-swap");\nwhich()');
			const next = await run(`%bun add ${later}`);

			expect(swap.details).toHaveProperty("isError", true);
			expect(textOf(swap)).toContain(
				"the install left node_modules/senpi-url-swap/index.js linked outside the revision, so nothing was published",
			);
			expect(tree(active)).toEqual(before);
			expect(textOf(imported).trim()).toBe('"dir"');
			expect(next.details).not.toHaveProperty("isError", true);
		} finally {
			server.close();
		}
	}, 240_000);

	it("When bun replaces a directory install with a same-name archive whose top directory is not package/, then the import gets the archive's code", async () => {
		const { fixtures, run } = await session("bun");
		const source = await packageDir(fixtures, "senpi-gh-swap", 'export const which = () => "dir";\n');
		const stage = join(fixtures, "gh-stage", "repo-abc123");
		await mkdir(stage, { recursive: true });
		await writeFile(
			join(stage, "package.json"),
			JSON.stringify({ name: "senpi-gh-swap", version: "2.0.0", type: "module", main: "index.js" }),
		);
		await writeFile(join(stage, "index.js"), 'export const which = () => "archive";\n');
		const archive = join(fixtures, "repo-abc123.tgz");
		execFileSync("tar", ["-czf", archive, "-C", join(fixtures, "gh-stage"), "repo-abc123"]);

		await run(`%bun add ${source}`);
		const swap = await run(`%bun add ${archive}`);
		const imported = await run('const { which } = await import("senpi-gh-swap");\nwhich()');

		expect(swap.details).not.toHaveProperty("isError", true);
		expect(textOf(imported).trim()).toBe('"archive"');
	}, 240_000);

	it("When the managed root cannot be created because a file is in the way, then the error names no host path", async () => {
		const outer = await mkdtemp(join(tmpdir(), "senpi-js-blocked-"));
		cleanupDirs.push(outer);
		await writeFile(join(outer, "a-file"), "not a directory\n");
		const managedRoot = join(outer, "a-file", "managed");
		const { fixtures, run } = await session("npm", managedRoot);
		const tarball = await packFixture(fixtures, "senpi-blocked-root", "1.0.0", probeSource);

		const install = await run(`%npm add ${tarball}`);

		expect(install.details).toHaveProperty("isError", true);
		expect(textOf(install)).toContain("environment_install_failed");
		expect(textOf(install)).not.toContain(outer);
		expect(textOf(install)).not.toContain(realpathSync(outer));
	}, 120_000);

	it.each([["npm"], ["bun"]] as const)(
		"When %s replaces a tarball install with a same-name directory, then the import gets the directory's code",
		async (installer) => {
			const { fixtures, run } = await session(installer);
			const tarball = await packFixture(
				fixtures,
				"senpi-tgz-swap",
				"1.0.0",
				'export const which = () => "tarball";\n',
			);
			const source = await packageDir(fixtures, "senpi-tgz-swap", 'export const which = () => "dir";\n');

			await run(`%${installer} add ${tarball}`);
			const replaced = await run(`%${installer} add ${source}`);
			const imported = await run('const { which } = await import("senpi-tgz-swap");\nwhich()');

			expect(replaced.details).not.toHaveProperty("isError", true);
			expect(textOf(imported).trim()).toBe('"dir"');
		},
		240_000,
	);

	it("When npm installs a directory and then two tarballs under a managed root reached through a link, then the third imports and npm's lockfile names no staging directory", async () => {
		const outer = await mkdtemp(join(tmpdir(), "senpi-js-linkroot-"));
		cleanupDirs.push(outer);
		await mkdir(join(outer, "real"));
		await symlink(join(outer, "real"), join(outer, "via-link"));
		const { fixtures, run } = await session("npm", join(outer, "via-link", "managed"));
		const source = await packageDir(fixtures, "senpi-link-root-dir", probeSource);
		const second = await packFixture(fixtures, "senpi-link-root-two", "1.0.0", probeSource);
		const third = await packFixture(
			fixtures,
			"senpi-link-root-three",
			"1.0.0",
			'export const three = () => "three";\n',
		);

		await run(`%npm add ${source}`);
		await run(`%npm add ${second}`);
		const last = await run(`%npm add ${third}`);
		const imported = await run('const { three } = await import("senpi-link-root-three");\nthree()');
		const revision =
			(await readActiveRevision(join(outer, "real", "managed", "environments", "js", "test")))?.dir ?? "";

		expect(last.details).not.toHaveProperty("isError", true);
		expect(textOf(imported).trim()).toBe('"three"');
		// npm keys each package by its path and records where a link points; neither may name a staging directory, or the
		// lockfile stops resolving once the staged revision is renamed.
		const lock = JSON.parse(await readFile(join(revision, "package-lock.json"), "utf8")) as {
			packages: Record<string, { resolved?: string }>;
		};
		const paths = Object.entries(lock.packages).flatMap(([key, entry]) => [key, entry.resolved ?? ""]);
		expect(paths.filter((path) => path.includes(".staging-rev"))).toEqual([]);
	}, 240_000);

	it("When npm installs a directory and then two tarballs in a session's default environment, then the third imports", async () => {
		const { fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-default-dir", probeSource);
		const second = await packFixture(fixtures, "senpi-default-two", "1.0.0", probeSource);
		const third = await packFixture(
			fixtures,
			"senpi-default-three",
			"1.0.0",
			'export const three = () => "three";\n',
		);

		await run(`%npm add ${source}`);
		await run(`%npm add ${second}`);
		const last = await run(`%npm add ${third}`);
		const imported = await run('const { three } = await import("senpi-default-three");\nthree()');

		expect(last.details).not.toHaveProperty("isError", true);
		expect(textOf(imported).trim()).toBe('"three"');
	}, 240_000);

	it.each([["npm"], ["bun"]] as const)(
		"When %s installed a scoped package from a directory, then the next install succeeds and the source is untouched",
		async (installer) => {
			const { fixtures, run } = await session(installer);
			const source = await packageDir(fixtures, "@senpi-scope/dir-pkg", probeSource);
			const next = await packFixture(fixtures, "senpi-after-scoped", "1.0.0", probeSource);
			const before = tree(source);

			await run(`%${installer} add ${source}`);
			const second = await run(`%${installer} add ${next}`);
			const imported = await run('const { probe } = await import("@senpi-scope/dir-pkg");\nprobe()');

			expect(second.details).not.toHaveProperty("isError", true);
			expect(textOf(imported).trim()).toBe('"ok"');
			expect(tree(source)).toEqual(before);
		},
		240_000,
	);

	it.each([["npm"], ["bun"]] as const)(
		"When the directory %s installed from is deleted, then the next install is refused and the previous revision stays active",
		async (installer) => {
			const { root, fixtures, run } = await session(installer);
			const source = await packageDir(fixtures, "senpi-dir-gone", probeSource);
			const next = await packFixture(fixtures, "senpi-after-gone", "1.0.0", probeSource);
			await run(`%${installer} add ${source}`);
			const active = (await readActiveRevision(activeBase(root)))?.dir;
			await rm(source, { recursive: true });

			const second = await run(`%${installer} add ${next}`);

			expect(second.details).toHaveProperty("isError", true);
			expect(textOf(second)).toContain("links outside its revision");
			expect((await readActiveRevision(activeBase(root)))?.dir).toBe(active);
		},
		240_000,
	);

	it("When one of bun's links into a recorded directory is repointed at another file of that directory, then the next install is refused", async () => {
		const { root, fixtures, run } = await session("bun");
		const source = await packageDir(fixtures, "senpi-dir-repoint", probeSource);
		const next = await packFixture(fixtures, "senpi-after-repoint", "1.0.0", probeSource);
		await run(`%bun add ${source}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		const link = join(revision, "node_modules", "senpi-dir-repoint", "index.js");
		await rm(link);
		await symlink(join(source, "package.json"), link);

		const second = await run(`%bun add ${next}`);

		expect(second.details).toHaveProperty("isError", true);
		expect(textOf(second)).toContain("node_modules/senpi-dir-repoint/index.js links outside its revision");
	}, 240_000);

	it("When a package's link points outside the revision at a directory no install recorded, then the next install is refused and that directory is untouched", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-recorded", probeSource);
		const unrecorded = await packageDir(fixtures, "senpi-dir-unrecorded", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await symlink(unrecorded, join(revision, "node_modules", "senpi-dir-unrecorded"));
		const before = tree(unrecorded);

		const next = await run(`%npm add ${tarball}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("node_modules/senpi-dir-unrecorded links outside its revision");
		expect(tree(unrecorded)).toEqual(before);
	}, 240_000);

	it("When one package's link points at the directory recorded for another package, then the next install is refused", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-owner", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await symlink(source, join(revision, "node_modules", "senpi-dir-borrower"));

		const next = await run(`%npm add ${tarball}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("node_modules/senpi-dir-borrower links outside its revision");
	}, 240_000);

	it("When an installer path of the revision links at a recorded source directory, then the next install is refused and the source is untouched", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-target", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await rm(join(revision, "package-lock.json"));
		await symlink(join(source, "package.json"), join(revision, "package-lock.json"));
		const before = tree(source);

		const next = await run(`%npm add ${tarball}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("package-lock.json links outside its revision");
		expect(tree(source)).toEqual(before);
	}, 240_000);

	it("When the active revision no longer records the directory an earlier revision installed from, then its link is refused", async () => {
		const { root, fixtures, run } = await session("npm");
		const source = await packageDir(fixtures, "senpi-dir-forgotten", probeSource);
		const tarball = await packFixture(fixtures, "senpi-dir-next", "1.0.0", probeSource);
		const later = await packFixture(fixtures, "senpi-dir-later", "1.0.0", probeSource);
		await run(`%npm add ${source}`);
		await run(`%npm add ${tarball}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		const manifestPath = join(revision, "package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies: Record<string, string> };
		delete manifest.dependencies["senpi-dir-forgotten"];
		await writeFile(manifestPath, JSON.stringify(manifest));

		const next = await run(`%npm add ${later}`);

		expect(textOf(next)).toContain("node_modules/senpi-dir-forgotten links outside its revision");
		expect((await readActiveRevision(activeBase(root)))?.dir).toBe(revision);
	}, 240_000);
});

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a managed JavaScript revision", () => {
	it("When the revision's node_modules is a relative link to a directory inside it, then the next install is refused and that directory is untouched", async () => {
		const { root, fixtures, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-inner-first", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-inner-second", "1.0.0", probeSource);
		await run(`%npm add ${first}`);
		const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
		await mkdir(join(revision, "kept"));
		await writeFile(join(revision, "kept", "marker"), "unchanged\n");
		await rm(join(revision, "node_modules"), { recursive: true });
		await symlink("kept", join(revision, "node_modules"));

		const next = await run(`%npm add ${second}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("node_modules is a link; refusing to write through it");
		expect(tree(join(revision, "kept"))).toEqual({ marker: "unchanged\n" });
	}, 240_000);

	it("When a package in the revision is an absolute link to another package of that revision, then the next install is refused and the revision is untouched", async () => {
		const { root, fixtures, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-abs-first", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-abs-second", "1.0.0", probeSource);
		await run(`%npm add ${first}`);
		const revision = realpathSync((await readActiveRevision(activeBase(root)))?.dir ?? "");
		await symlink(
			join(revision, "node_modules", "senpi-abs-first"),
			join(revision, "node_modules", "senpi-abs-alias"),
		);
		const before = tree(revision);

		const next = await run(`%npm add ${second}`);

		expect(next.details).toHaveProperty("isError", true);
		expect(textOf(next)).toContain("node_modules/senpi-abs-alias is an absolute link into its revision");
		expect(tree(revision)).toEqual(before);
	}, 240_000);

	it("When an install runs under umask 022, then every managed directory and the revision are private to the user", async () => {
		const previous = process.umask(0o022);
		try {
			const { root, fixtures, run } = await session("npm");
			const tarball = await packFixture(fixtures, "senpi-private", "1.0.0", probeSource);
			await run(`%npm add ${tarball}`);
			const revision = (await readActiveRevision(activeBase(root)))?.dir ?? "";
			const levels = [
				join(root, "artifacts"),
				join(root, "artifacts", "environments"),
				join(root, "artifacts", "environments", "js"),
				activeBase(root),
				revision,
			];

			expect(levels.map((dir) => [relative(root, dir), (statSync(dir).mode & 0o777).toString(8)])).toEqual(
				levels.map((dir) => [relative(root, dir), "700"]),
			);
		} finally {
			process.umask(previous);
		}
	}, 240_000);

	it("When npm is told to install globally by its config, then the install still lands in the revision and imports", async () => {
		const { fixtures, run } = await session("npm", undefined, {
			...process.env,
			npm_config_global: "true",
			npm_config_location: "global",
		});
		const tarball = await packFixture(fixtures, "senpi-not-global", "1.0.0", probeSource);

		const install = await run(`%npm add ${tarball}`);
		const imported = await run('const { probe } = await import("senpi-not-global");\nprobe()');

		expect(textOf(install)).toContain("added senpi-not-global with npm");
		expect(textOf(imported).trim()).toBe('"ok"');
	}, 240_000);
});
