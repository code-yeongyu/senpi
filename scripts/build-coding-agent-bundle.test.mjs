import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { commonBuildOptions, findContainingOutput, validateExternalImports } from "./build-coding-agent-bundle.mjs";
import { lazyEntryPoints } from "./bundle-entry-points.mjs";

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

import { readFileSync, readdirSync } from "node:fs";

describe("zod single copy", () => {
	it("redirects MCP SDK zod subpath imports to the coding-agent zod whatever the hoisted layout", async () => {
		// Given: an npm-style layout whose hoisted zod/v4 is a 4.0.0 copy, imported by a fake MCP SDK
		const scratch = mkdtempSync(join(tmpdir(), "senpi-bundle-zod-"));
		try {
			const mcp = join(scratch, "node_modules", "@modelcontextprotocol", "sdk");
			mkdirSync(mcp, { recursive: true });
			writeFileSync(join(mcp, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", type: "module", main: "index.js" }));
			writeFileSync(join(mcp, "index.js"), 'import * as z from "zod/v4"; console.log(z.z.string().parse("x"));');
			const old = join(scratch, "node_modules", "zod");
			mkdirSync(join(old, "v4"), { recursive: true });
			writeFileSync(join(old, "package.json"), JSON.stringify({ name: "zod", version: "3.25.76", exports: { "./v4": "./v4/index.js" } }));
			writeFileSync(join(old, "v4", "index.js"), "export const z = { string: () => ({ parse: (v) => v }) }; export const version = { major: 4, minor: 0, patch: 0 };");

			// When
			const result = await build({
				...commonBuildOptions(),
				stdin: { contents: 'import "@modelcontextprotocol/sdk";', loader: "js", resolveDir: scratch, sourcefile: "probe.js" },
				write: false,
			});

			// Then: the hoisted 4.0.0 copy is not bundled and the pinned copy is
			assert.equal(Object.keys(result.metafile.inputs).some((input) => input.includes("senpi-bundle-zod-") && input.includes("/zod/")), false);
			assert.doesNotMatch(result.outputFiles[0].text, /major:\s*4,\s*minor:\s*0,\s*patch:\s*0/);
		} finally {
			rmSync(scratch, { force: true, recursive: true });
		}
	});

	it("ships no zod 4.x core older than 4.6.6 in the built bundle outside the Claude agent SDK's embedded copy", () => {
		// Given: the built bundle (a full build runs before the script tests in CI)
		const bundleDir = join(repoRoot, "packages", "coding-agent", "dist", "bundle");
		let files;
		try {
			files = readdirSync(bundleDir, { recursive: true }).map(String).filter((file) => file.endsWith(".js"));
		} catch {
			return;
		}

		// When
		const found = [];
		for (const file of files) {
			for (const match of readFileSync(join(bundleDir, file), "utf8").matchAll(/major:4,minor:(\d+),patch:(\d+)/g)) {
				found.push({ file, version: `4.${match[1]}.${match[2]}`, minor: Number(match[1]), patch: Number(match[2]) });
			}
		}

		// Then: 4.6.2 is only the SDK-embedded copy, which sits in the SDK's own chunk
		const stale = found.filter((entry) => entry.minor < 6 || (entry.minor === 6 && entry.patch < 6));
		assert.deepEqual(
			stale.filter((entry) => entry.version !== "4.6.2"),
			[],
		);
		assert.ok(stale.every((entry) => /^chunks\/(sdk|session-worker)/.test(entry.file)), JSON.stringify(stale));
	});
});
