import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

const probeSource = 'export const probe = () => "ok";\n';
const outers: string[] = [];

afterEach(async () => {
	for (const outer of outers.splice(0)) await rm(outer, { recursive: true, force: true });
});

async function outerDir(): Promise<string> {
	const outer = await mkdtemp(join(tmpdir(), "senpi-js-contain-"));
	outers.push(outer);
	return outer;
}

/** Every `node_modules` directory under `root`, outside `except`. */
function nodeModulesOutside(root: string, except: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (path === except || !entry.isDirectory()) continue;
			if (entry.name === "node_modules") found.push(relative(root, path));
			else walk(path);
		}
	};
	walk(root);
	return found;
}

function snapshot(dir: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(dir).map((name) => {
			const path = join(dir, name);
			return [name, statSync(path).isFile() ? readFileSync(path, "utf8") : "<dir>"];
		}),
	);
}

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a managed JavaScript environment", () => {
	it("When %bun add and %npm add run under ancestors that each hold a package.json and a bun.lock, then every ancestor and the home directory stay byte-identical and no node_modules appears outside the managed root", async () => {
		const outer = await outerDir();
		const home = join(outer, "home");
		const ancestors = [outer, home, join(home, "a"), join(home, "a", "b")];
		const managedRoot = join(home, "a", "b", "managed");
		await mkdir(join(home, "a", "b"), { recursive: true });
		for (const dir of ancestors) {
			await writeFile(join(dir, "package.json"), `{"name":"sentinel-${ancestors.indexOf(dir)}","private":true}\n`);
			await writeFile(join(dir, "bun.lock"), `sentinel lock ${ancestors.indexOf(dir)}\n`);
		}
		const before = ancestors.map((dir) => [
			readFileSync(join(dir, "package.json"), "utf8"),
			readFileSync(join(dir, "bun.lock"), "utf8"),
		]);
		const { project, fixtures, run } = await session("auto", managedRoot, { ...process.env, HOME: home });
		const projectManifest = readFileSync(join(project, "package.json"), "utf8");
		const viaBun = await packFixture(fixtures, "senpi-contain-bun", "1.0.0", probeSource);
		const viaNpm = await packFixture(fixtures, "senpi-contain-npm", "1.0.0", probeSource);

		const bunInstall = await run(`%bun add ${viaBun}`);
		const npmInstall = await run(`%npm add ${viaNpm}`);
		const imported = await run('const { probe } = await import("senpi-contain-bun");\nprobe()');

		expect(textOf(bunInstall)).toContain("added senpi-contain-bun with bun");
		expect(textOf(npmInstall)).toContain("added senpi-contain-npm with npm");
		expect(textOf(imported).trim()).toBe('"ok"');
		expect(
			ancestors.map((dir) => [
				readFileSync(join(dir, "package.json"), "utf8"),
				readFileSync(join(dir, "bun.lock"), "utf8"),
			]),
		).toEqual(before);
		expect(nodeModulesOutside(outer, managedRoot)).toEqual([]);
		expect(readFileSync(join(project, "package.json"), "utf8")).toBe(projectManifest);
		expect(existsSync(join(project, "node_modules"))).toBe(false);
		expect(existsSync(join(project, "bun.lock"))).toBe(false);
	}, 240_000);

	it.each([["environments"], [join("environments", "js")], [join("environments", "js", "test")]])(
		"When %s under the managed root is a link to another directory, then the install is refused and that directory is untouched",
		async (level) => {
			const outer = await outerDir();
			const managedRoot = join(outer, "managed");
			const elsewhere = join(outer, "elsewhere");
			await mkdir(elsewhere, { recursive: true });
			await writeFile(join(elsewhere, "package.json"), '{"name":"elsewhere","private":true}\n');
			await mkdir(join(managedRoot, level, ".."), { recursive: true });
			await symlink(elsewhere, join(managedRoot, level));
			const before = snapshot(elsewhere);
			const { fixtures, run } = await session("bun", managedRoot);
			const tarball = await packFixture(fixtures, "senpi-contain-level", "1.0.0", probeSource);

			const install = await run(`%bun add ${tarball}`);

			expect(install.details).toHaveProperty("isError", true);
			expect(textOf(install)).toContain("is a link; refusing to write through it");
			expect(textOf(install)).not.toContain(outer);
			expect(snapshot(elsewhere)).toEqual(before);
		},
		180_000,
	);

	it.each([["package.json"], ["node_modules"]])(
		"When the active revision's %s is a link into the project, then the next install is refused and the project is untouched",
		async (entry) => {
			const { project, fixtures, environments, run } = await session("npm");
			const first = await packFixture(fixtures, "senpi-inner-a", "1.0.0", probeSource);
			const second = await packFixture(fixtures, "senpi-inner-b", "1.0.0", probeSource);
			await run(`%npm add ${first}`);
			await mkdir(join(project, "node_modules"), { recursive: true });
			const revisionEntry = join(environments.packageRoot ?? "", entry);
			await rm(revisionEntry, { recursive: true, force: true });
			await symlink(join(project, entry), revisionEntry);
			const before = snapshot(project);
			const beforeModules = readdirSync(join(project, "node_modules"));

			const install = await run(`%npm add ${second}`);

			expect(install.details).toHaveProperty("isError", true);
			expect(textOf(install)).toMatch(/is a link; refusing to write through it|links outside its revision/);
			expect(snapshot(project)).toEqual(before);
			expect(readdirSync(join(project, "node_modules"))).toEqual(beforeModules);
		},
		180_000,
	);

	it("When a package inside the active revision is a link out of it, then the next install is refused before anything is copied", async () => {
		const { project, fixtures, environments, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-deep-a", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-deep-b", "1.0.0", probeSource);
		await run(`%npm add ${first}`);
		const outside = join(project, "outside-package");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "package.json"), '{"name":"senpi-deep-a","version":"9.9.9"}\n');
		const inner = join(environments.packageRoot ?? "", "node_modules", "senpi-deep-a");
		await rm(inner, { recursive: true, force: true });
		await symlink(outside, inner);
		const before = snapshot(outside);

		const install = await run(`%npm add ${second}`);

		expect(install.details).toHaveProperty("isError", true);
		expect(textOf(install)).toContain("links outside its revision");
		expect(snapshot(outside)).toEqual(before);
		expect(existsSync(join(outside, "node_modules"))).toBe(false);
	}, 180_000);

	it("When the active revision is a link to a project directory, then the next install is refused and the directory is untouched", async () => {
		const { root, project, fixtures, environments, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-link-rev-a", "1.0.0", probeSource);
		const second = await packFixture(fixtures, "senpi-link-rev-b", "1.0.0", probeSource);
		await run(`%npm add ${first}`);
		const revision = environments.packageRoot ?? "";
		const target = join(project, "looks-like-a-revision");
		await rename(revision, target);
		await symlink(target, revision);
		const before = readdirSync(target).sort();

		const install = await run(`%npm add ${second}`);

		expect(install.details).toHaveProperty("isError", true);
		expect(textOf(install)).toContain("rev-1 is a link; refusing to write through it");
		expect(textOf(install)).not.toContain(root);
		expect(readdirSync(target).sort()).toEqual(before);
	}, 180_000);

	it("When npm recorded an earlier tarball by a relative path that is now gone, then a later install never names its directory", async () => {
		const outer = await outerDir();
		const { fixtures, run } = await session("npm");
		const gone = await packFixture(outer, "senpi-relative-gone", "1.0.0", probeSource);
		const next = await packFixture(fixtures, "senpi-relative-next", "1.0.0", probeSource);
		await run(`%npm add ${gone}`);
		await rm(gone, { force: true });

		const later = await run(`%npm add ${next}`);

		expect(textOf(later)).not.toContain(relative("/", outer).split("/").pop() ?? outer);
	}, 180_000);
});
