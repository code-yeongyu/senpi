import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRuntimeSnapshot } from "../../src/runtime-snapshot/enter.ts";
import { createFakeInstall, type FakeInstall } from "./fake-install.ts";

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function snapshotOf(install: FakeInstall): Promise<string> {
	const decision = await prepareRuntimeSnapshot(install.entryPath, install.packageDir, install.agentDir);
	if (decision.kind !== "hand-off") throw new Error(`expected a hand-off, got ${decision.kind}`);
	return decision.snapshotDir;
}

function asCheckout(install: FakeInstall, files: string[]): void {
	const manifestPath = join(install.packageDir, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
	writeFileSync(manifestPath, JSON.stringify({ ...manifest, files }));
	write(join(install.packageDir, "README.md"), "# senpi\n");
	write(join(install.packageDir, "LICENSE"), "MIT\n");
	write(join(install.packageDir, "CHANGELOG.md"), "# Changelog\n");
	write(join(install.packageDir, "src/cli.ts"), "export {};\n");
	write(join(install.packageDir, "test/cli.test.ts"), "export {};\n");
	write(join(install.packageDir, "scripts/build.mjs"), "export {};\n");
	write(join(install.packageDir, "dist/experimental/preview.js"), "export {};\n");
	write(join(install.packageDir, "tsconfig.json"), "{}\n");
}

// #3083: a snapshot copies the package as npm ships it, not a checkout's sources and tests.
describe("runtime snapshot copies only the shipped package files (#3083)", () => {
	const installs: FakeInstall[] = [];
	afterEach(() => {
		while (installs.length) installs.pop()?.cleanup();
	});

	it("copies the files entries and npm's always-shipped files, minus the negated entries", async () => {
		// Given: a checkout whose package.json lists what it ships
		const install = createFakeInstall("build-a", "nested");
		installs.push(install);
		asCheckout(install, ["dist", "!dist/experimental", "docs", "CHANGELOG.md", "*.json", "!tsconfig.json"]);

		// When
		const snapshotDir = await snapshotOf(install);

		// Then
		const topLevel = readdirSync(snapshotDir).filter(
			(name) => !["node_modules", "runtime-snapshot.json", "claims"].includes(name),
		);
		expect(topLevel.sort()).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "dist", "docs", "package.json"]);
		expect(existsSync(join(snapshotDir, "dist/bundle/cli.js"))).toBe(true);
		expect(existsSync(join(snapshotDir, "dist/experimental"))).toBe(false);
		expect(existsSync(join(snapshotDir, "node_modules/native-ext/package.json"))).toBe(true);
	});

	it("copies the whole package directory when package.json has no files field", async () => {
		// Given
		const install = createFakeInstall("build-a", "nested");
		installs.push(install);
		write(join(install.packageDir, "extra/notes.txt"), "kept\n");

		// When
		const snapshotDir = await snapshotOf(install);

		// Then
		expect(readFileSync(join(snapshotDir, "extra/notes.txt"), "utf8")).toBe("kept\n");
	});

	it("lists none of this checkout's source, test or script trees among the shipped files", () => {
		// Given: the real package, as this repository checks it out
		const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { files: string[] };

		// Then
		const listed = manifest.files.filter((entry) => !entry.startsWith("!")).map((entry) => entry.split("/")[0]);
		for (const checkoutOnly of ["src", "test", "scripts", "bench", "node_modules"]) {
			expect(listed).not.toContain(checkoutOnly);
		}
	});
});
