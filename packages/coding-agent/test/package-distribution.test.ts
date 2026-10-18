import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { pi: string; senpi: string };
	main: string;
	files: string[];
	exports: Record<string, Record<string, string>>;
	scripts: Record<string, string>;
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin.pi).toBe("dist/bundle/cli.js");
		expect(packageJson.bin.senpi).toBe("dist/bundle/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./client"].import).toBe("./dist/client/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/rpc-entry.js");
	});

	// Naming the executables one by one is how `bin.senpi` drifted: upstream moved `pi` onto the
	// bundle and the fork's own command kept the module graph the bundle exists to replace, which
	// costs a launch roughly five seconds of pre-main evaluation. Assert the rule instead of the
	// names, so a third executable cannot inherit the same gap.
	test("every declared executable boots the bundled entry", () => {
		for (const [name, target] of Object.entries(packageJson.bin)) {
			expect(`${name} -> ${target}`).toBe(`${name} -> dist/bundle/cli.js`);
		}
	});

	// The release build is the only producer of `dist/bundle/`: `bin.pi` points into it, the
	// packed tarball ships whatever `dist` holds, and nothing else in the repo runs the bundler.
	// Wiring it into the package `build` script is what makes a published tarball executable.
	test("builds the bundle that bin.pi resolves to as part of the package build", () => {
		expect(packageJson.scripts["build:bundle"]).toContain("scripts/build-coding-agent-bundle.mjs");
		expect(packageJson.scripts.build).toContain("build:bundle");
		expect(packageJson.files).toContain("dist");
	});

	// Regression for #9132, expressed on the fork's distribution shape: internal experimental
	// entrypoints must not become published runtime exports. Upstream pins this by publishing
	// `./client` and `./experimental/plugin` as `source` entries; the fork publishes `./client`
	// from dist (C03/C14) and ships no `./experimental/plugin` export at all (Q-C), so the same
	// invariant is pinned here as absence of that export, absence of any source-only export, and
	// the packaging excludes that keep experimental output out of the tarball.
	test("keeps experimental entrypoints out of the published surface", () => {
		expect(packageJson.exports["./experimental/plugin"]).toBeUndefined();

		for (const [name, entry] of Object.entries(packageJson.exports)) {
			expect(entry.source, `${name} must not be published as source`).toBeUndefined();
			for (const [condition, target] of Object.entries(entry)) {
				expect(target, `${name}.${condition} must resolve inside dist`).toMatch(/^\.\/dist\//);
			}
		}

		expect(packageJson.files).toContain("!dist/experimental");
		expect(packageJson.files).toContain("!dist/cli/experimental");
	});
});
