import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceEntry = new URL("../src/models.ts", import.meta.url).href;
const sourceFaux = new URL("../src/providers/faux.ts", import.meta.url).href;
const builtEntry = fileURLToPath(new URL("../dist/models.js", import.meta.url));

// Install before linking the static imports, so unused barrel re-exports are checked too.
const preload = `data:text/javascript,${encodeURIComponent(`
	import { registerHooks } from "node:module";
	const forbidden = [
		"/node_modules/typebox/",
		"/node_modules/@anthropic-ai/sdk/",
		"/node_modules/openai/",
		"/node_modules/@google/genai/",
		"/node_modules/@aws-sdk/",
		"/providers/data/",
		"/models.generated.",
	];
	registerHooks({
		load(url, context, nextLoad) {
			if (forbidden.some((part) => url.includes(part))) {
				throw new Error("Heavy dependency loaded by models entry: " + url);
			}
			return nextLoad(url, context);
		},
	});
`)}`;

describe("lightweight models entry", () => {
	// senpi#3252: the source entry runs from source alone; the package subpath resolves to the build output, so it
	// names that precondition instead of failing on a missing module.
	it.each([
		{ entry: sourceEntry, faux: sourceFaux, needsBuild: false },
		{ entry: "@earendil-works/pi-ai/models", faux: "@earendil-works/pi-ai/providers/faux", needsBuild: true },
	])("runs a faux completion without TypeBox, catalogs, or SDKs through $entry", ({ entry, faux, needsBuild }) => {
		if (needsBuild) {
			expect(existsSync(builtEntry), "the package subpath needs the build: bun run --cwd packages/ai build").toBe(
				true,
			);
		}
		const script = `
				import assert from "node:assert/strict";
				import { createModels, createProvider } from ${JSON.stringify(entry)};
				import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(faux)};
				assert.equal(typeof createProvider, "function");
				const models = createModels();
				assert.deepEqual(models.getModels(), []);
				assert.deepEqual(models.getProviders(), []);
				const faux = fauxProvider();
				models.setProvider(faux.provider);
				faux.setResponses([fauxAssistantMessage("OK")]);
				const response = await models.completeSimple(faux.getModel(), { messages: [] });
				assert.equal(response.stopReason, "stop");
				assert.deepEqual(response.content, [{ type: "text", text: "OK" }]);
			`;
		const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "--eval", script], {
			cwd: packageRoot,
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	});
});
