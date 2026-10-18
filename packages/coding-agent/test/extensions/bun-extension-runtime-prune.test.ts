import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const sourceDir = fileURLToPath(new URL("../../src/core/extensions/", import.meta.url));
const RUNTIME_FILES = [
	"bun-extension-commonjs.ts",
	"bun-extension-error.ts",
	"bun-extension-importer.ts",
	"bun-extension-registry.ts",
];
// The runtime-path tag the importer appends to its metadata import; a runtime built before senpi#3300 had none.
const RUNTIME_TAG = / \/\/ runtime \$\{runtimeModulePath === undefined \? "virtual" : encodeURI\(runtimeModulePath\)\}/;
// The runtime copy imports these; each is linked from wherever the install placed it (hoisted or not).
const RUNTIME_PACKAGES = ["es-module-lexer", "zod"];
const requireFromSource = createRequire(join(sourceDir, "bun-extension-importer.ts"));
// Bun caches a transpile only past a size threshold, so the extension is padded well over it.
const PAD = "x".repeat(80_000);
const bun = process.env.SENPI_TEST_BUN ?? "bun";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installRuntime(root: string, name: string, builtBeforeFix: boolean): string {
	const dir = join(root, name, "extensions");
	mkdirSync(dir, { recursive: true });
	for (const file of RUNTIME_FILES) copyFileSync(join(sourceDir, file), join(dir, file));
	if (builtBeforeFix) {
		const importer = join(dir, "bun-extension-importer.ts");
		const source = readFileSync(importer, "utf8");
		expect(source).toMatch(RUNTIME_TAG);
		writeFileSync(importer, source.replace(RUNTIME_TAG, ""));
	}
	const runtimeModule = join(sourceDir, "extension-runtime-module.ts");
	copyFileSync(runtimeModule, join(dir, "extension-runtime-module.ts"));
	const shipped = execFileSync(bun, ["build", runtimeModule, "--no-bundle"], { encoding: "utf8", timeout: 30_000 });
	writeFileSync(join(dir, "extension-runtime-module.js"), shipped);
	return dir;
}

function packageDir(name: string): string {
	const entry = requireFromSource.resolve(name);
	const marker = `${join("node_modules", name)}`;
	return entry.slice(0, entry.lastIndexOf(marker) + marker.length);
}

function linkRuntimePackages(root: string): void {
	mkdirSync(join(root, "node_modules"), { recursive: true });
	for (const name of RUNTIME_PACKAGES) symlinkSync(packageDir(name), join(root, "node_modules", name), "junction");
}

function loadExtension(runtimeDir: string, extension: string, cacheDir: string): string {
	return execFileSync(
		bun,
		[
			"--eval",
			`const { createBunExtensionImporter } = await import(${JSON.stringify(join(runtimeDir, "bun-extension-importer.ts"))});
const factory = await createBunExtensionImporter({}).import(${JSON.stringify(extension)}, { default: true });
process.stdout.write(factory());`,
		],
		{ encoding: "utf8", timeout: 30_000, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: cacheDir } },
	);
}

describe("senpi#3300 an unchanged extension survives a runtime update that prunes the old runtime", () => {
	it.each([
		["a runtime built before the fix", true],
		["a runtime with the fix", false],
	])(
		"#given an extension cached by %s #when the update prunes it #then the new runtime still loads the extension",
		(_label, builtBeforeFix) => {
			const root = mkdtempSync(join(tmpdir(), "senpi-runtime-prune-"));
			roots.push(root);
			linkRuntimePackages(root);
			const cacheDir = join(root, "transpile-cache");
			const extension = join(root, "extension.ts");
			writeFileSync(extension, `export const pad = ${JSON.stringify(PAD)};\nexport default () => "loaded";\n`);

			const previous = installRuntime(root, "runtime-a", builtBeforeFix);
			expect(loadExtension(previous, extension, cacheDir)).toBe("loaded");
			rmSync(join(root, "runtime-a"), { recursive: true, force: true });

			const updated = installRuntime(root, "runtime-b", false);
			expect(loadExtension(updated, extension, cacheDir)).toBe("loaded");
		},
	);
});
