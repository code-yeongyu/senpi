import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeRuntimeBuildId, parseRuntimeBuildId } from "../src/modes/rpc/runtime-build-id.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PROFILE = { extensions: [], multi_session: true, session_runtime: "in-process" } as const;
const ENGINE = "2026.10.1-3";

function install(
	files: Record<string, string>,
	plugin: Record<string, string> = { "index.js": "export default 1;\n" },
) {
	const root = mkdtempSync(join(tmpdir(), "rbid-"));
	roots.push(root);
	const bundle = join(root, "pkg", "dist", "bundle");
	const pluginDir = join(root, "plugin");
	for (const [dir, entries] of [
		[bundle, files],
		[pluginDir, plugin],
	] as const) {
		for (const [name, text] of Object.entries(entries)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
	}
	return { root, bundle, pluginDir };
}

function idOf(runtime: { bundle: string; pluginDir: string }, flavour: "packaged" | "dev" = "packaged") {
	return computeRuntimeBuildId({
		profile: { ...PROFILE, extensions: [runtime.pluginDir] },
		source: { flavour, root: runtime.bundle },
		engine: ENGINE,
		platform: "darwin",
		arch: "arm64",
	});
}

describe("runtimeBuildId", () => {
	it("tells two builds of the same version apart", async () => {
		const first = await idOf(install({ "cli.js": "console.log('build one');\n" }));
		const second = await idOf(install({ "cli.js": "console.log('build two');\n" }));

		expect(parseRuntimeBuildId(first)).toBe(first);
		expect(parseRuntimeBuildId(second)).toBe(second);
		expect(first).not.toBe(second);
	});

	it("changes when the bundle is replaced at the same path", async () => {
		const runtime = install({ "cli.js": "v1\n", "chunks/a.js": "a1\n" });
		const before = await idOf(runtime);

		writeFileSync(join(runtime.bundle, "chunks", "a.js"), "a2\n");

		expect(await idOf(runtime)).not.toBe(before);
	});

	it("gives one build one id wherever it is installed", async () => {
		const original = install({ "cli.js": "same\n", "chunks/a.js": "a\n" });
		const copy = mkdtempSync(join(tmpdir(), "rbid-copy-"));
		roots.push(copy);
		cpSync(original.root, copy, { recursive: true });

		expect(await idOf({ bundle: join(copy, "pkg", "dist", "bundle"), pluginDir: join(copy, "plugin") })).toBe(
			await idOf(original),
		);
	});

	it("follows plugin content and the runtime flavour", async () => {
		const runtime = install({ "cli.js": "same\n" });
		const packaged = await idOf(runtime);
		const dev = await idOf(runtime, "dev");

		writeFileSync(join(runtime.pluginDir, "index.js"), "export default 2;\n");

		expect(dev).not.toBe(packaged);
		expect(await idOf(runtime)).not.toBe(packaged);
	});

	it("ignores what changes without changing the build", async () => {
		const runtime = install({ "cli.js": "same\n" });
		const before = await idOf(runtime);

		writeFileSync(join(runtime.bundle, ".DS_Store"), "finder state");
		writeFileSync(join(runtime.bundle, "runtime-manifest.json"), '{"buildId":"x"}');
		writeFileSync(join(runtime.bundle, "cli.js.map"), "{}");
		mkdirSync(join(runtime.pluginDir, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(runtime.pluginDir, "node_modules", "dep", "index.js"), "installed later");

		expect(await idOf(runtime)).toBe(before);
	});

	it("fails instead of guessing when the runtime cannot be read", async () => {
		const missing = { bundle: join(tmpdir(), "rbid-missing", "bundle"), pluginDir: join(tmpdir(), "rbid-missing") };

		await expect(idOf(missing)).rejects.toMatchObject({ code: "ENOENT" });
		expect(parseRuntimeBuildId("sha256:short")).toBeUndefined();
	});
});
