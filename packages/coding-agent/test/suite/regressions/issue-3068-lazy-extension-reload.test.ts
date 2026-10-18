import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

const loaderPath = fileURLToPath(new URL("../../../src/core/resource-loader.ts", import.meta.url));
const cachePath = fileURLToPath(new URL("../../../src/core/extensions/extension-module-cache.ts", import.meta.url));
const tsconfigPath = fileURLToPath(new URL("../../../../../tsconfig.json", import.meta.url));
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("edited lazy extension dependencies on reload", () => {
	// senpi#3068: the helper is first compiled AFTER its factory was cached. The next load must
	// compare against those compiled bytes, not adopt the edited file as the old module's identity.
	it.each(["direct", "transitive", "commonjs", "same-metadata", "deleted"])("%s dependency", (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "senpi-lazy-reload-"));
		roots.push(root);
		execFileSync(
			"bun",
			[
				"--tsconfig-override",
				tsconfigPath,
				"--eval",
				`
import assert from "node:assert/strict";
import { writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader } from ${JSON.stringify(loaderPath)};
import { extensionModuleGenerationCount } from ${JSON.stringify(cachePath)};
const root = ${JSON.stringify(root)};
const scenario = ${JSON.stringify(scenario)};
const entry = join(root, "extension.ts");
const helper = join(root, scenario === "commonjs" ? "helper.cjs" : "helper.ts");
const changed = scenario === "transitive" ? join(root, "leaf.ts") : helper;
const source = value => scenario === "commonjs"
	? "module.exports = { value: " + JSON.stringify(value) + " };\\n"
	: "export const value = " + JSON.stringify(value) + ";\\n";
writeFileSync(changed, source("before"));
if (scenario === "transitive") writeFileSync(helper, 'export { value } from "./leaf.ts";\\n');
writeFileSync(entry, 'export default pi => pi.registerCommand("probe", { handler: async () => { const m = await import('
	+ JSON.stringify("./" + (scenario === "commonjs" ? "helper.cjs" : "helper.ts"))
	+ '); globalThis.__lazyReloadValue = ' + (scenario === "commonjs" ? "m.default.value" : "m.value") + '; } });');
// A fixed, exactly representable timestamp makes the same-metadata case independent of FS ticks.
const timestamp = new Date("2020-01-01T00:00:00Z");
utimesSync(changed, timestamp, timestamp);
const original = statSync(changed, { bigint: true });
const loader = new DefaultResourceLoader({
	cwd: root, agentDir: root, additionalExtensionPaths: [entry],
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
});
const command = () => {
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	const probe = result.extensions.flatMap(ext => [...ext.commands.values()]).find(cmd => cmd.name === "probe");
	assert.ok(probe);
	return probe.handler("", {});
};
// Given: the extension factory is cached before the command first imports its helper.
await loader.reload();
await command();
assert.equal(globalThis.__lazyReloadValue, "before");
const generations = extensionModuleGenerationCount();
// When: only that late-compiled dependency changes, then the loader reloads.
const expected = scenario === "same-metadata" ? "after!" : "after-edited";
if (scenario === "deleted") rmSync(changed);
else {
	writeFileSync(changed, source(expected));
	utimesSync(changed, timestamp, timestamp);
	if (scenario === "same-metadata") {
		const edited = statSync(changed, { bigint: true });
		assert.equal(edited.size, original.size);
		assert.equal(edited.mtimeNs, original.mtimeNs);
	}
}
await loader.reload();
// Then: a fresh graph serves the new bytes (or reports a deleted dependency), never the old value.
if (scenario === "deleted") await assert.rejects(command);
else {
	await command();
	assert.equal(globalThis.__lazyReloadValue, expected);
	assert.equal(extensionModuleGenerationCount(), generations + 1);
	await loader.reload();
	await command();
	assert.equal(globalThis.__lazyReloadValue, expected);
	assert.equal(extensionModuleGenerationCount(), generations + 1, "unchanged reload must reuse the graph");
}
process.exit(0);
`,
			],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, SENPI_CODING_AGENT_DIR: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
			},
		);
	});
});
