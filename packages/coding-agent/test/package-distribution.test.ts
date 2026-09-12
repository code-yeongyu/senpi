import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { pi: string; senpi: string };
	main: string;
	files: string[];
	exports: Record<string, Record<string, string>>;
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin.pi).toBe("dist/bundle/cli.js");
		expect(packageJson.bin.senpi).toBe("dist/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./client"].import).toBe("./dist/client/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/rpc-entry.js");
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
