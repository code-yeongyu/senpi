import { existsSync, readFileSync } from "node:fs";
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
	// One copy of the code per install (senpi#7659): executables, the root entry and every library subpath load the
	// bundle; the per-file tree is a build input that ships only its declarations.
	test("serves executables and every library entry from the bundle", () => {
		expect(packageJson.bin.pi).toBe("dist/bundle/cli.js");
		expect(packageJson.bin.senpi).toBe("dist/bundle/cli.js");
		expect(packageJson.main).toBe("./dist/bundle/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/bundle/index.js");
		expect(packageJson.exports["./client"].import).toBe("./dist/bundle/client.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
	});

	// An embedding program that rewrites argv or env before importing the CLI imports this first, so the
	// OSC 7577 hand-off re-execs the launch it was given rather than the rewritten one (senpi#7493).
	test("publishes the OSC 7577 hand-off as its own side-effect entry", () => {
		expect(packageJson.exports["./program-resume-startup"]?.import).toBe("./dist/bundle/program-resume-startup.js");
	});

	// A manifest path that names nothing the build emits ships a broken entry: each export's declaration must come from a
	// source file the build compiles (tsconfig.build.json: rootDir ./src, outDir ./dist, test and experimental paths
	// excluded), and its `import` must be the bundle entry scripts/bundle-entry-points.mjs builds from that module. A
	// renamed or moved source fails here, not at an embedder's import.
	test("every export is a bundle entry built from a compiled source file, with its types", () => {
		// The paths the build leaves out, as tsconfig.build.json names them (directory entries under src/ only; its
		// node_modules, dist and *.test.ts entries never name an export's source).
		const buildConfig = JSON.parse(readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8")) as {
			exclude: string[];
		};
		const excluded = buildConfig.exclude.filter((path) => path.startsWith("src/")).map((path) => `${path}/`);
		expect(excluded.length).toBeGreaterThan(0);
		for (const [name, entry] of Object.entries(packageJson.exports)) {
			// A data export names a JSON file the bundle build writes into `dist/bundle/` (`./runtime-manifest.json`);
			// scripts/build-coding-agent-bundle.test.mjs checks that the built bundle carries it.
			if (entry.import === undefined) {
				expect({ name, target: entry.default }).toEqual({
					name,
					target: expect.stringMatching(/^\.\/dist\/bundle\/[^/]+\.json$/),
				});
				continue;
			}
			expect({ name, import: entry.import }).toEqual({
				name,
				import: `./dist/bundle/${name === "." ? "index" : name.slice(2)}.js`,
			});
			const module = /^\.\/dist\/(.+)\.d\.ts$/.exec(entry.types ?? "")?.[1];
			expect({ name, typed: module !== undefined }).toEqual({ name, typed: true });
			const source = `src/${module}.ts`;
			expect({ name, source, exists: existsSync(new URL(`../${source}`, import.meta.url)) }).toEqual({
				name,
				source,
				exists: true,
			});
			expect({ name, excluded: excluded.some((prefix) => source.startsWith(prefix)) }).toEqual({
				name,
				excluded: false,
			});
		}
		// What every export resolves to ships: the bundle and the declarations (scripts/senpi-publish-pack-checks.mjs
		// checks each named file in the packed tarball).
		expect(packageJson.files).toEqual(expect.arrayContaining(["dist/bundle", "dist/**/*.d.ts"]));
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
	// packed tarball ships `dist/bundle`, and nothing else in the repo runs the bundler.
	// Wiring it into the package `build` script is what makes a published tarball executable.
	test("builds the bundle that bin.pi resolves to as part of the package build", () => {
		expect(packageJson.scripts["build:bundle"]).toContain("scripts/build-coding-agent-bundle.mjs");
		expect(packageJson.scripts.build).toContain("build:bundle");
		expect(packageJson.files).toContain("dist/bundle");
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
