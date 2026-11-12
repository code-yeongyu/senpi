import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { commonBuildOptions, findContainingOutput, mainBuildOptions, validateExternalImports } from "./build-coding-agent-bundle.mjs";
import { lazyEntryPoints } from "./bundle-entry-points.mjs";
import { assertBundleZodCores, describeStaleZodAllowances, STALE_ZOD_ALLOWANCE, sdkSourceOutputs } from "./bundle-zod-core-guard.mjs";

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

describe("built bundle zod cores", () => {
	it("ships no zod core older than 4.6.6 beyond the pinned Claude agent SDK copies, in the SDK's exact chunk", async () => {
		// Given: the built bundle. CI builds it before the script tests (release-graph-codemode, node-bundle-smoke);
		// a missing or empty bundle is a failed scan, not a skipped one (senpi#6497 review). The SDK's chunk is named by
		// the metafile of the same graph rebuilt in memory (same options, same chunk hashes), not by a name pattern: the
		// build also emits an unrelated chunks/sdk-*.js (senpi#6514 review).
		const bundleDir = join(repoRoot, "packages", "coding-agent", "dist", "bundle");
		const main = await build({ ...mainBuildOptions(), write: false });
		const lazyDir = dirname(findContainingOutput(main.metafile, "packages/ai/dist/api/bedrock-converse-stream.lazy.js"));
		const worker = await build({
			...commonBuildOptions(),
			entryNames: "[name]",
			entryPoints: { "session-worker": lazyEntryPoints({ codingAgentDistDir: join(repoRoot, "packages", "coding-agent", "dist"), aiDistDir: join(repoRoot, "packages", "ai", "dist") })["session-worker"] },
			outdir: lazyDir,
			splitting: false,
			write: false,
		});
		const outputs = sdkSourceOutputs([main.metafile, worker.metafile], bundleDir);
		const sdkChunk = outputs.find((file) => file !== "chunks/session-worker.js");
		assert.match(sdkChunk, /^chunks\/sdk-[A-Z0-9]+\.js$/);
		assert.deepEqual(outputs, [sdkChunk, "chunks/session-worker.js"]);

		// When / Then: one 4.6.2 core and one zod/v3 layer in that exact chunk and in the session worker, nothing else
		// stale, and the report names the pinned SDK version and source hashes.
		const report = describeStaleZodAllowances(assertBundleZodCores(bundleDir, outputs));
		const sdk = `@anthropic-ai/claude-agent-sdk ${STALE_ZOD_ALLOWANCE.sdkVersion}`;
		assert.deepEqual(report.slice(STALE_ZOD_ALLOWANCE.sources.length), [
			`allowed stale zod copy: ${sdk} ${sdkChunk} zod 4.6.2 core`,
			`allowed stale zod copy: ${sdk} ${sdkChunk} zod/v3 layer`,
			`allowed stale zod copy: ${sdk} chunks/session-worker.js zod 4.6.2 core`,
			`allowed stale zod copy: ${sdk} chunks/session-worker.js zod/v3 layer`,
		]);
		assert.deepEqual(
			report.slice(0, STALE_ZOD_ALLOWANCE.sources.length),
			STALE_ZOD_ALLOWANCE.sources.map((source) => `pinned stale zod source: ${sdk} ${source.path} sha256:${source.sha256} (${source.stale.map((version) => (version === "3.x" ? "zod/v3 layer" : `zod ${version} core`)).join(", ")})`),
		);
	});
});
