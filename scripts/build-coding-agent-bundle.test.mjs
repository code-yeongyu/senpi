import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { commonBuildOptions, findContainingOutput, validateExternalImports } from "./build-coding-agent-bundle.mjs";
import { lazyEntryPoints } from "./bundle-entry-points.mjs";
import { assertBundleZodCores } from "./bundle-zod-core-guard.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const permissionSystemSrc = join(repoRoot, "packages", "coding-agent", "src", "core", "extensions", "builtin", "permission-system");
// The PTY loader resolves native files relative to its own package directory, so inlining it
// into the bundle would point it at the bundle directory instead.
const NATIVE_SIDECAR_PACKAGES = ["@earendil-works/pi-pty"];

describe("build-coding-agent-bundle", () => {
	it("keeps native-sidecar packages external when coding-agent imports them", async () => {
		// Given: a coding-agent module importing every native-sidecar package.
		const contents = NATIVE_SIDECAR_PACKAGES.map((name, index) => `import * as native${index} from "${name}";\nconsole.log(native${index});`).join("\n");

		// When
		const result = await build({
			...commonBuildOptions(),
			stdin: { contents, loader: "js", resolveDir: join(repoRoot, "packages", "coding-agent"), sourcefile: "probe.js" },
			write: false,
		});

		// Then
		const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports);
		assert.deepEqual(
			NATIVE_SIDECAR_PACKAGES.filter((name) => !imports.some((imported) => imported.path === name && imported.external)),
			[],
		);
		assert.doesNotThrow(() => validateExternalImports([result.metafile]));
	});

	it("emits the path identity worker beside its host so the built host answers a resolve request", async () => {
		// Given: the bundle layout (main graph with splitting, lazy worker entries emitted beside the chunk that
		// starts them), built from the sources the dist files compile to.
		const scratch = mkdtempSync(join(tmpdir(), "senpi-bundle-worker-"));
		try {
			const outdir = join(scratch, "bundle");
			const main = await build({
				...commonBuildOptions(),
				entryNames: "[name]",
				entryPoints: { host: join(permissionSystemSrc, "path-identity-host.ts") },
				outdir,
				chunkNames: "chunks/[name]-[hash]",
				splitting: true,
			});
			const hostOutput = findContainingOutput(main.metafile, "permission-system/path-identity-host.ts");
			const lazy = lazyEntryPoints({
				codingAgentDistDir: join(repoRoot, "packages", "coding-agent", "src"),
				aiDistDir: join(repoRoot, "packages", "ai", "src"),
			});
			assert.ok(lazy["path-identity-worker"], "the lazy bundle entries do not emit the path identity worker");
			await build({
				...commonBuildOptions(),
				entryNames: "[name]",
				entryPoints: { "path-identity-worker": lazy["path-identity-worker"].replace(/\.js$/, ".ts") },
				outdir: dirname(hostOutput),
				splitting: false,
			});
			const fixture = join(scratch, "fixture");
			mkdirSync(join(fixture, "real"), { recursive: true });
			writeFileSync(join(fixture, "real", "secret"), "S");
			symlinkSync(join(fixture, "real"), join(fixture, "link"));

			// When: the host from the built output starts its worker and resolves a symlinked path.
			const { createPathIdentityResolver } = await import(pathToFileURL(hostOutput).href);
			const resolver = createPathIdentityResolver({ log: () => {} });
			try {
				const canonical = await resolver.canonicalize(join(fixture, "link", "secret"));
				// Then
				assert.equal(canonical.path, join(realpathSync.native(fixture), "real", "secret"));
				assert.equal(resolver.unavailable, undefined);
			} finally {
				await resolver.close();
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("built bundle exports", () => {
	// Package contract of the `exports` map: every subpath resolves to a file the built bundle carries, either its own
	// entry (named for the subpath, `.` as index.js) or, for a data export, the file it names inside dist/bundle.
	it("emits an entry or the named file for every exports subpath", () => {
		// Given: the built bundle and the manifest that ships it.
		const codingAgentDir = join(repoRoot, "packages", "coding-agent");
		const { exports } = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));

		// When
		const missing = Object.entries(exports)
			.map(([subpath, conditions]) =>
				conditions.import === undefined
					? conditions.default
					: `./dist/bundle/${subpath === "." ? "index" : subpath.slice(2)}.js`,
			)
			.filter((target) => !existsSync(join(codingAgentDir, target)));

		// Then
		assert.deepEqual(missing, []);
	});
});

describe("built bundle runtime manifest", () => {
	// Embedder contract: `extensionModules` is exactly what the extension loader serves, so a launcher staging an
	// extension's dependencies (oh-my-openagent's compiled binary) skips those and nothing else.
	it("lists exactly the specifiers the compiled extension loader serves", async () => {
		// Given: the built bundle's manifest and the compiled loader it was built from.
		const codingAgentDir = join(repoRoot, "packages", "coding-agent");
		const manifest = JSON.parse(readFileSync(join(codingAgentDir, "dist", "bundle", "runtime-manifest.json"), "utf8"));
		const loader = pathToFileURL(join(codingAgentDir, "dist", "core", "extensions", "loader.js")).href;

		// When
		const { VIRTUAL_MODULES } = await import(loader);

		// Then: the same set, including the senpi subpaths the loader spreads in.
		assert.deepEqual([...manifest.extensionModules].sort(), Object.keys(VIRTUAL_MODULES).sort());
		assert.ok(manifest.extensionModules.includes("@code-yeongyu/senpi"));
		assert.ok(manifest.extensionModules.includes("@code-yeongyu/senpi/session-worker-data"));
	});
});

describe("built bundle zod cores", () => {
	it("ships no zod core older than 4.6.6 beyond the pinned Claude agent SDK copies", () => {
		// Given: the built bundle. CI builds it before the script tests (release-graph-codemode, node-bundle-smoke);
		// a missing or empty bundle is a failed scan, not a skipped one (senpi#6497 review).
		const bundleDir = join(repoRoot, "packages", "coding-agent", "dist", "bundle");

		// When / Then: exactly one 4.6.2 in the SDK's chunk and one in the session worker, nothing else stale
		assert.deepEqual(
			assertBundleZodCores(bundleDir).map((entry) => `${entry.file.replace(/^chunks\/sdk-[^/]+\.js$/, "chunks/sdk-*.js")} ${entry.version}`),
			["chunks/sdk-*.js 4.6.2", "chunks/session-worker.js 4.6.2"],
		);
	});
});
