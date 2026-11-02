import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

const probeSource = 'export const probe = () => "ok";\n';
const secondSource = 'export const second = () => "two";\n';

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a JavaScript eval session", () => {
	it("When %bun add installs a local tarball, then the next cell imports it and the project's package.json is untouched", async () => {
		const { project, fixtures, run } = await session("bun");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const manifest = await readFile(join(project, "package.json"), "utf8");

		const install = await run(`%bun add ${tarball}`);
		const imported = await run('const { probe } = await import("senpi-probe");\nprobe()');

		expect(textOf(install)).toMatch(/added senpi-probe with bun into managed \(revision 1\)/);
		expect(textOf(imported)).toContain("ok");
		expect(await readFile(join(project, "package.json"), "utf8")).toBe(manifest);
		expect(existsSync(join(project, "node_modules"))).toBe(false);
	}, 180_000);

	it("When an import cell is queued behind a %bun add cell that is itself queued behind a running cell, then the import resolves the newly installed package", async () => {
		const { fixtures, run } = await session();
		const tarball = await packFixture(fixtures, "senpi-queued-probe", "1.0.0", probeSource);

		// All three are submitted before the install runs: the import was queued when no revision existed yet.
		const [, install, imported] = await Promise.all([
			run("await new Promise((resolve) => setTimeout(resolve, 1500))"),
			run(`%bun add ${tarball}`),
			run("const { probe } = await import('senpi-queued-probe'); probe()"),
		]);

		expect(textOf(install)).toMatch(/added senpi-queued-probe with bun into managed \(revision 1\)/);
		expect(textOf(imported)).toContain("ok");
	}, 180_000);

	it("When npm is the installer, then %npm add installs the same way", async () => {
		const { fixtures, run } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);

		const install = await run(`%npm add ${tarball}`);
		const imported = await run('const { probe } = await import("senpi-probe");\nprobe()');

		expect(textOf(install)).toMatch(/added senpi-probe with npm into managed \(revision 1\)/);
		expect(textOf(imported)).toContain("ok");
	}, 180_000);

	it("When a second install succeeds, then the new revision still resolves the first package", async () => {
		const { fixtures, run } = await session("bun");
		const first = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-second", "1.0.0", secondSource);

		await run(`%bun add ${first}`);
		const install = await run(`%bun add ${second}`);
		const both = await run(
			'const a = await import("senpi-probe");\nconst b = await import("senpi-second");\n[a.probe(), b.second()].join("+")',
		);

		expect(textOf(install)).toMatch(/revision 2/);
		expect(textOf(both)).toContain("ok+two");
	}, 180_000);

	it("When an install fails, then the cell reports environment_install_failed with no host path, and the previous revision stays active", async () => {
		const { root, fixtures, environments, run } = await session("bun");
		const good = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const broken = await packFixture(fixtures, "senpi-broken", "1.0.0", "export const x = 1;\n", {
			"senpi-nonexistent-dependency-for-tests": "file:./does-not-exist",
		});
		await run(`%bun add ${good}`);
		const before = environments.packageRoot;

		const failure = await run(`%bun add ${broken}`);
		const still = await run('const { probe } = await import("senpi-probe");\nprobe()');

		expect(textOf(failure)).toContain("environment_install_failed");
		expect(textOf(failure)).not.toContain(root);
		expect(textOf(failure)).not.toContain(homedir());
		expect(environments.packageRoot).toBe(before);
		expect(textOf(still)).toContain("ok");
	}, 180_000);

	it("When %environment project is selected, then installs go into the project directory", async () => {
		const { project, fixtures, run } = await session("bun");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);

		const switched = await run("%environment project");
		const install = await run(`%bun add ${tarball}`);

		expect(textOf(switched)).toContain("environment: project");
		expect(textOf(install)).toContain("into project");
		expect(existsSync(join(project, "node_modules", "senpi-probe"))).toBe(true);
	}, 180_000);

	it("When installer flags are passed, then the cell is refused because the host chooses the destination", async () => {
		const { run } = await session("bun");

		const refused = await run("%bun add --global left-pad");

		expect(textOf(refused)).toContain("installer flags are chosen by the host");
	}, 60_000);

	it("When %npm add runs with the installer setting on auto and bun also on PATH, then npm installs", async () => {
		const { fixtures, run } = await session("auto");
		const tarball = await packFixture(fixtures, "senpi-npm-choice", "1.0.0", probeSource);

		const install = await run(`%npm add ${tarball}`);

		expect(textOf(install)).toMatch(/added senpi-npm-choice with npm into managed/);
	}, 180_000);

	it("When %bun add names a package directory relative to the session directory, then it installs as %npm add would", async () => {
		const { project, run } = await session("bun");
		const local = join(project, "localpkg");
		await mkdir(local, { recursive: true });
		await writeFile(
			join(local, "package.json"),
			JSON.stringify({ name: "senpi-local", version: "1.0.0", type: "module", main: "index.js" }),
		);
		await writeFile(join(local, "index.js"), probeSource);

		const install = await run("%bun add ./localpkg");
		const imported = await run('const { probe } = await import("senpi-local");\nprobe()');

		expect(textOf(install)).toMatch(/added senpi-local with bun into managed/);
		expect(textOf(imported)).toContain("ok");
	}, 180_000);

	it("When a package name carries a control character, then the cell is refused with an environment error before any installer runs", async () => {
		const { run } = await session("bun");

		const refused = await run("%bun add bad\u0001name");

		expect(textOf(refused)).toContain("environment_install_failed");
		expect(textOf(refused)).toContain("package names cannot contain control characters");
	}, 180_000);

	it("When the project has the package as a directory with only index.js, then the install reports the conflict", async () => {
		const { project, fixtures, run } = await session("bun");
		await mkdir(join(project, "node_modules", "senpi-index-only"), { recursive: true });
		await writeFile(
			join(project, "node_modules", "senpi-index-only", "index.js"),
			"export const where = () => 'project';\n",
		);
		const tarball = await packFixture(fixtures, "senpi-index-only", "1.0.0", probeSource);

		const install = await run(`%bun add ${tarball}`);

		expect(textOf(install)).toContain("environment_resolution_conflict: senpi-index-only still resolves");
	}, 180_000);

	it("When an earlier install came from a tarball outside the session, then a later install never names its directory", async () => {
		const { root, fixtures, run } = await session("bun");
		const first = await packFixture(fixtures, "senpi-echo-first", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-echo-second", "1.0.0", probeSource);
		await run(`%bun add ${first}`);

		const later = await run(`%bun add ${second}`);

		expect(textOf(later)).not.toContain(basename(root));
	}, 180_000);

	it("When the package is hoisted in a parent node_modules, then the install reports the conflict and the import gets the hoisted copy; an empty package directory does not", async () => {
		const { root, project, fixtures, run } = await session("bun");
		const hoistedDir = join(root, "node_modules", "senpi-hoisted");
		await mkdir(hoistedDir, { recursive: true });
		await writeFile(
			join(hoistedDir, "package.json"),
			JSON.stringify({ name: "senpi-hoisted", version: "9.9.9", type: "module", main: "index.js" }),
		);
		await writeFile(join(hoistedDir, "index.js"), 'export const probe = () => "hoisted";\n');
		await mkdir(join(project, "node_modules", "senpi-empty"), { recursive: true });
		const hoisted = await packFixture(fixtures, "senpi-hoisted", "1.0.0", probeSource);
		const empty = await packFixture(fixtures, "senpi-empty", "1.0.0", probeSource);

		const hoistedInstall = await run(`%bun add ${hoisted}`);
		const emptyInstall = await run(`%bun add ${empty}`);
		const imported = await run('const { probe } = await import("senpi-hoisted");\nprobe()');

		expect(textOf(hoistedInstall)).toContain("environment_resolution_conflict: senpi-hoisted");
		expect(textOf(imported).trim()).toBe('"hoisted"');
		expect(textOf(emptyInstall)).not.toContain("environment_resolution_conflict");
	}, 180_000);

	it.each([
		["main names a missing file", { main: "missing.js" }, []],
		["no main and only index.mjs", {}, ["index.mjs"]],
		["index.js is a directory", {}, ["index.js/"]],
	] as const)(
		"When the project's copy has %s, then the install reports no conflict and the import gets the managed package",
		async (_label, manifest, files) => {
			const { project, fixtures, run } = await session("bun");
			const projectCopy = join(project, "node_modules", "senpi-unresolvable");
			await mkdir(projectCopy, { recursive: true });
			await writeFile(
				join(projectCopy, "package.json"),
				JSON.stringify({ name: "senpi-unresolvable", version: "9.9.9", ...manifest }),
			);
			for (const file of files) {
				if (file.endsWith("/")) await mkdir(join(projectCopy, file), { recursive: true });
				else await writeFile(join(projectCopy, file), 'export const probe = () => "project";\n');
			}
			const tarball = await packFixture(fixtures, "senpi-unresolvable", "1.0.0", probeSource);

			const install = await run(`%bun add ${tarball}`);
			const imported = await run('const { probe } = await import("senpi-unresolvable");\nprobe()');

			expect(textOf(install)).not.toContain("environment_resolution_conflict");
			expect(textOf(imported).trim()).toBe('"ok"');
		},
		180_000,
	);

	it("When %environment switches and a tarball outside the session directory is installed, then no absolute path reaches the cell", async () => {
		const { root, fixtures, run } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-path-probe", "1.0.0", probeSource);

		const switched = await run("%environment managed");
		const install = await run(`%npm add ${tarball}`);

		for (const text of [textOf(switched), textOf(install)]) {
			expect(text).not.toContain(root);
			expect(text).not.toContain(fixtures);
		}
	}, 180_000);
});
