import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createJiti } from "jiti/static";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";

const temporaryDirectories: string[] = [];

async function createFixtureDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "senpi-loader-concurrency-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeFixture(directory: string, name: string, source: string): Promise<string> {
	const fixturePath = path.join(directory, name);
	await writeFile(fixturePath, source);
	return fixturePath;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("extension loader import concurrency", () => {
	it("supports concurrent imports through one jiti importer with shared and unique transitive dependencies", async () => {
		const directory = await createFixtureDirectory();
		await writeFixture(directory, "shared.ts", 'export const value = "shared";\n');
		const extensionPaths = await Promise.all(
			Array.from({ length: 3 }, async (_, index) => {
				await writeFixture(directory, `unique-${index}.ts`, `export const value = "unique-${index}";\n`);
				return writeFixture(
					directory,
					`extension-${index}.ts`,
					`import { value as shared } from "./shared.ts";\nimport { value as unique } from "./unique-${index}.ts";\nexport default () => \`${index}:\${shared}:\${unique}\`;\n`,
				);
			}),
		);
		const importer = createJiti(import.meta.url, { moduleCache: false });

		for (let iteration = 0; iteration < 20; iteration++) {
			const factories = await Promise.all(
				extensionPaths.map((extensionPath) => importer.import<() => string>(extensionPath, { default: true })),
			);

			expect(factories.map((factory) => factory())).toEqual([
				"0:shared:unique-0",
				"1:shared:unique-1",
				"2:shared:unique-2",
			]);
		}
	});

	it("picks up a transitive dependency edit on the next load", async () => {
		const directory = await createFixtureDirectory();
		const dependencyPath = await writeFixture(directory, "dependency.ts", 'export const description = "before";\n');
		const extensionPath = await writeFixture(
			directory,
			"extension.ts",
			'import { description } from "./dependency.ts";\nexport default (pi) => pi.registerCommand("freshness", { description, handler: async () => {} });\n',
		);

		const first = await loadExtensions([extensionPath], directory);
		await writeFile(dependencyPath, 'export const description = "after-edited";\n');
		const second = await loadExtensions([extensionPath], directory);

		expect(first.errors).toEqual([]);
		expect(first.extensions[0]?.commands.get("freshness")?.description).toBe("before");
		expect(second.errors).toEqual([]);
		expect(second.extensions[0]?.commands.get("freshness")?.description).toBe("after-edited");
	});

	it("preserves import and factory failure attribution", async () => {
		const directory = await createFixtureDirectory();
		const importFailurePath = await writeFixture(
			directory,
			"import-failure.ts",
			'throw new Error("import fixture failure");\n',
		);
		const factoryFailurePath = await writeFixture(
			directory,
			"factory-failure.ts",
			'export default () => { throw new Error("factory fixture failure"); };\n',
		);

		const result = await loadExtensions([importFailurePath, factoryFailurePath], directory);

		expect(result.extensions).toEqual([]);
		expect(result.errors).toEqual([
			{ path: importFailurePath, error: "Failed to load extension: import fixture failure" },
			{ path: factoryFailurePath, error: "Failed to load extension: factory fixture failure" },
		]);
	});
});
