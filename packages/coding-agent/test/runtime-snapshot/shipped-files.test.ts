import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

	it("ships a root file selected only by an include glob", async () => {
		// Given: no literal files entry names the metadata file.
		const install = createFakeInstall();
		installs.push(install);
		asCheckout(install, ["dist", "metadata-*.json"]);
		write(join(install.packageDir, "metadata-only.json"), '{"sentinel":3083}\n');
		write(join(install.packageDir, "unshipped.json"), "{}\n");

		// When
		const snapshotDir = await snapshotOf(install);

		// Then: removing glob expansion loses metadata; the pre-#3084 whole-tree copy leaks the other file.
		expect(readFileSync(join(snapshotDir, "metadata-only.json"), "utf8")).toBe('{"sentinel":3083}\n');
		expect(existsSync(join(snapshotDir, "unshipped.json"))).toBe(false);
	});
});
