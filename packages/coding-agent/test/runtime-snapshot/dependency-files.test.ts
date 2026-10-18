import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRuntimeSnapshot } from "../../src/runtime-snapshot/enter.ts";
import { createFakeInstall, type FakeInstall } from "./fake-install.ts";

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

describe("runtime dependency payload (#3083)", () => {
	const installs: FakeInstall[] = [];
	afterEach(() => {
		while (installs.length) installs.pop()?.cleanup();
	});

	it("copies src TypeScript when the dependency has no built JavaScript entry", async () => {
		// Given: a source-only dependency whose main imports src, not a manifest entry rooted in src (#3083).
		const install = createFakeInstall();
		installs.push(install);
		const dep = join(install.packageDir, "node_modules/nested-dep");
		rmSync(join(dep, "index.js"));
		write(join(dep, "package.json"), JSON.stringify({ name: "nested-dep", main: "index.ts" }));
		write(join(dep, "index.ts"), 'export { answer } from "./src/helper.ts";\n');
		write(join(dep, "src/helper.ts"), "export const answer = 42;\n");

		// When: the real snapshot materializer copies the dependency closure.
		const decision = await prepareRuntimeSnapshot(install.entryPath, install.packageDir, install.agentDir);
		expect(decision.kind).toBe("hand-off");
		if (decision.kind !== "hand-off") throw new Error("snapshot was not built");

		// Then: the source imported by the TypeScript entry survives copying.
		expect(readFileSync(join(decision.snapshotDir, "node_modules/nested-dep/src/helper.ts"), "utf8")).toBe(
			"export const answer = 42;\n",
		);
	});

	it("bounds files and bytes without removing executable entries or runtime-read assets", async () => {
		// Given: inert payload in a dependency, alongside built code and runtime assets.
		const install = createFakeInstall();
		installs.push(install);
		const modules = join(install.packageDir, "node_modules");
		const dep = join(modules, "nested-dep");
		write(join(dep, "package.json"), JSON.stringify({ name: "nested-dep", main: "dist/index.js" }));
		write(join(dep, "dist/index.js"), "module.exports = 42;\n");
		for (const dir of ["test", "tests", "__tests__", "fixtures", "docs", "examples", "src"]) {
			for (let n = 0; n < 10; n++) write(join(dep, dir, `unused-${n}.ts`), "x".repeat(4096));
		}
		write(join(dep, "README.md"), "# inert\n");
		write(join(dep, "CONTRIBUTING.md"), "# inert\n");
		write(join(dep, "LICENSE.md"), "MIT\n");
		write(join(dep, "dist/data.json"), '{"answer":42}\n');
		write(
			join(modules, "skill-pkg/package.json"),
			JSON.stringify({ name: "skill-pkg", main: "index.js", pi: "SKILL.md" }),
		);
		write(join(modules, "skill-pkg/SKILL.md"), "# declared root skill\n");
		// An export can legitimately live in a directory otherwise mistaken for documentation.
		write(
			join(modules, "native-helper/package.json"),
			JSON.stringify({
				name: "native-helper",
				main: "docs/index.js",
				exports: { ".": "./docs/index.js" },
			}),
		);
		write(join(modules, "native-helper/docs/index.js"), 'module.exports = "kept";\n');

		// When
		const decision = await prepareRuntimeSnapshot(install.entryPath, install.packageDir, install.agentDir);
		expect(decision.kind).toBe("hand-off");
		if (decision.kind !== "hand-off") throw new Error("snapshot was not built");
		const copied = join(decision.snapshotDir, "node_modules");
		const files = readdirSync(copied, { recursive: true })
			.map(String)
			.filter((file) => statSync(join(copied, file)).isFile());
		const bytes = files.reduce((sum, file) => sum + statSync(join(copied, file)).size, 0);

		// Then: budget has headroom for metadata, but cannot hide even one inert fixture tree.
		expect(files.length).toBeLessThanOrEqual(20);
		expect(bytes).toBeLessThan(4096);
		for (const dir of ["test", "tests", "__tests__", "fixtures", "docs", "examples"])
			expect(existsSync(join(copied, "nested-dep", dir)), dir).toBe(false);
		expect(files.some((file) => file.startsWith("nested-dep/src/"))).toBe(false);
		expect(existsSync(join(copied, "nested-dep/README.md"))).toBe(false);
		expect(existsSync(join(copied, "nested-dep/CONTRIBUTING.md"))).toBe(false);
		expect(readFileSync(join(copied, "nested-dep/LICENSE.md"), "utf8")).toBe("MIT\n");
		expect(readFileSync(join(copied, "native-helper/docs/index.js"), "utf8")).toContain("kept");
		expect(readFileSync(join(copied, "nested-dep/dist/data.json"), "utf8")).toBe('{"answer":42}\n');
		expect(existsSync(join(copied, "native-ext/prebuilds/native.node"))).toBe(true);
		expect(readFileSync(join(copied, "skill-pkg/SKILL.md"), "utf8")).toContain("declared root skill");
		expect(existsSync(join(copied, "skill-pkg/src/skill/demo/SKILL.md"))).toBe(true);
	});
});
