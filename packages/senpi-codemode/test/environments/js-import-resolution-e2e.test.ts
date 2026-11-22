import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

async function projectPackage(project: string, name: string, source: string): Promise<void> {
	const dir = join(project, "node_modules", name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "9.9.9", type: "module", main: "index.js" }),
	);
	await writeFile(join(dir, "index.js"), source);
}

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))(
	"Given a JavaScript cell importing a package by bare name",
	() => {
		it("When only the session's project has the package, then the import resolves it from the project", async () => {
			const { project, run } = await session();
			await projectPackage(project, "senpi-project-only", 'export const where = () => "project";\n');

			const imported = await run('const { where } = await import("senpi-project-only");\nwhere()');

			expect(textOf(imported).trim()).toBe('"project"');
		}, 180_000);

		it("When the project and the managed revision both have the package, then the project's copy loads", async () => {
			const { project, fixtures, run } = await session("bun");
			await projectPackage(project, "senpi-dup", 'export const where = () => "project";\n');
			const tarball = await packFixture(fixtures, "senpi-dup", "1.0.0", 'export const where = () => "managed";\n');
			await run(`%bun add ${tarball}`);

			const imported = await run('const { where } = await import("senpi-dup");\nwhere()');

			expect(textOf(imported).trim()).toBe('"project"');
			expect(textOf(imported)).not.toContain("managed");
		}, 180_000);

		it("When the managed revision has a package Senpi itself also depends on, then the import loads the managed copy", async () => {
			const { fixtures, run } = await session("bun");
			const tarball = await packFixture(
				fixtures,
				"typebox",
				"0.0.1-senpi-fixture",
				'export const where = () => "managed";\n',
			);
			await run(`%bun add ${tarball}`);

			const imported = await run(
				'const mod = await import("typebox");\ntypeof mod.where === "function" ? mod.where() : "senpi"',
			);

			expect(textOf(imported).trim()).toBe('"managed"');
		}, 180_000);

		it("When the managed package is ESM-only, exporting just an import entry, then the import loads it", async () => {
			const { fixtures, run } = await session("bun");
			const tarball = await packFixture(
				fixtures,
				"senpi-esm-only",
				"1.0.0",
				'export const where = () => "esm";\n',
				undefined,
				{
					main: undefined,
					exports: { ".": { import: "./index.js" } },
				},
			);
			await run(`%bun add ${tarball}`);

			const imported = await run('const { where } = await import("senpi-esm-only");\nwhere()');

			expect(textOf(imported).trim()).toBe('"esm"');
		}, 180_000);

		it("When a subpath pattern match climbs out with .., then the import is refused like Node refuses it", async () => {
			const { project, run } = await session();
			const dir = join(project, "node_modules", "senpi-pattern");
			await mkdir(join(dir, "features"), { recursive: true });
			await writeFile(
				join(dir, "package.json"),
				JSON.stringify({
					name: "senpi-pattern",
					version: "1.0.0",
					type: "module",
					exports: { "./features/*": "./features/*.js" },
				}),
			);
			await writeFile(join(dir, "features", "a.js"), 'export const where = () => "feature";\n');
			await writeFile(join(dir, "secret.js"), 'export const where = () => "unexported";\n');

			const allowed = await run('const { where } = await import("senpi-pattern/features/a");\nwhere()');
			const escaped = await run(
				'await import("senpi-pattern/features/../secret").then((mod) => mod.where(), () => "refused")',
			);

			expect(textOf(allowed).trim()).toBe('"feature"');
			expect(textOf(escaped).trim()).toBe('"refused"');
		}, 180_000);
	},
);
