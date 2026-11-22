import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

const shared: string[] = [];

afterEach(async () => {
	for (const dir of shared.splice(0)) await rm(dir, { recursive: true, force: true });
});

const probe = (name: string) => `export const ${name} = () => "${name}";\n`;

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given JavaScript package revisions", () => {
	it("When two sessions sharing one managed root install at the same time, then each install lands in its own revision and both packages survive", async () => {
		const managedRoot = await mkdtemp(join(tmpdir(), "senpi-shared-managed-"));
		shared.push(managedRoot);
		const first = await session("npm", managedRoot);
		const second = await session("npm", managedRoot);
		const left = await packFixture(first.fixtures, "senpi-left", "1.0.0", probe("left"));
		const right = await packFixture(second.fixtures, "senpi-right", "1.0.0", probe("right"));

		const [one, two] = await Promise.all([first.run(`%npm add ${left}`), second.run(`%npm add ${right}`)]);
		const active = await readActiveRevision(join(managedRoot, "environments", "js", "test"));
		const manifest = JSON.parse(await readFile(join(active?.dir ?? "", "package.json"), "utf8"));

		expect([textOf(one), textOf(two)].map((text) => /revision (\d+)/.exec(text)?.[1]).sort()).toEqual(["1", "2"]);
		expect(active?.number).toBe(2);
		expect(Object.keys(manifest.dependencies).sort()).toEqual(["senpi-left", "senpi-right"]);
	}, 240_000);

	it("When a revision holds an .npmrc with credentials in any form, then the next revision carries only the registry settings", async () => {
		const { fixtures, environments, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-first", "1.0.0", probe("first"));
		const second = await packFixture(fixtures, "senpi-second", "1.0.0", probe("second"));
		await run(`%npm add ${first}`);
		const firstRoot = environments.packageRoot ?? "";
		await writeFile(
			join(firstRoot, ".npmrc"),
			`${[
				"@acme:registry=https://registry.example.test/",
				"//registry.example.test/:_authToken=secret-token",
				'"//registry.example.test/:_authToken"=secret-quoted',
				"_auth=c2VjcmV0",
				"key=secret-inline-key",
				"strict-ssl=true",
				"registry=http://urluser:urlsecret@registry.example.test/",
				"@query:registry=http://query.example.test/?token=querysecret",
				"@twoat:registry=http://a@b:twoatsecret@twoat.example.test/",
				"@oneslash:registry=http:/bu:oneslashsecret@oneslash.example.test/",
				'@scoped:registry="http://u:s@scoped.example.test/"',
				"@envvar:registry=https://envvar.example.test/t/$" + "{NPM_TOKEN}/",
			].join("\r\n")}\r//cr.example.test/:_authToken=secret-cr-only\r`,
		);
		await writeFile(
			join(firstRoot, "bunfig.toml"),
			'[install.registry]\nurl = "https://registry.example.test/"\ntoken = "secret-bunfig"\n',
		);

		await run(`%npm add ${second}`);
		const secondRoot = environments.packageRoot ?? "";
		const carried = await readFile(join(secondRoot, ".npmrc"), "utf8");

		expect(carried).toBe(
			[
				"@acme:registry=https://registry.example.test/",
				"strict-ssl=true",
				"registry=http://registry.example.test/",
				"@query:registry=http://query.example.test/",
				"@twoat:registry=http://twoat.example.test/",
				"@oneslash:registry=http://oneslash.example.test/",
				'@scoped:registry="http://scoped.example.test/"',
				"",
			].join("\n"),
		);
		expect(carried).not.toMatch(/secret|urluser|u:s@|bu:|envvar/);
		expect(existsSync(join(secondRoot, "bunfig.toml"))).toBe(false);
	}, 240_000);

	it("When a revision's .npmrc is a symlink to a real config file, then the next install is refused and that file stays byte-identical", async () => {
		const { root, fixtures, environments, run } = await session("npm");
		const first = await packFixture(fixtures, "senpi-link-first", "1.0.0", probe("first"));
		const second = await packFixture(fixtures, "senpi-link-second", "1.0.0", probe("second"));
		await run(`%npm add ${first}`);
		const realConfig = join(root, "real.npmrc");
		const original = "registry=https://registry.example.test/\n//registry.example.test/:_authToken=keep-me\n";
		await writeFile(realConfig, original);
		await symlink(realConfig, join(environments.packageRoot ?? "", ".npmrc"));

		const install = await run(`%npm add ${second}`);

		expect(install.details).toHaveProperty("isError", true);
		expect(textOf(install)).toContain(".npmrc links outside its revision");
		expect(await readFile(realConfig, "utf8")).toBe(original);
	}, 240_000);
});
