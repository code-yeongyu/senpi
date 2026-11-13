import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { commonBuildOptions } from "./build-coding-agent-bundle.mjs";
import { isMcpSdkOwnModule } from "./bundle-zod-single-copy-plugin.mjs";

// senpi#6497: the MCP SDK's `zod/v4` import must reach the pinned zod whatever the install layout hoisted, the build
// must fail rather than fall back to the hoisted copy, and only the SDK's own modules are redirected.

const STALE_CORE = /major:\s*4,\s*minor:\s*0,\s*patch:\s*0/;

/**
 * An npm-style layout: a hoisted zod whose every subpath reports a 4.0.0 core, a fake MCP SDK importing `sdkImport`,
 * and optionally a package nested under the SDK's own node_modules importing `zod/v4`.
 */
function hoistedLayout({ sdkImport, zodSubpaths = ["v4"], nested = false }) {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-bundle-zod-"));
	const sdk = join(scratch, "node_modules", "@modelcontextprotocol", "sdk");
	mkdirSync(sdk, { recursive: true });
	writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", type: "module", main: "index.js" }));
	writeFileSync(join(sdk, "index.js"), `import * as z from "${sdkImport}"; console.log(z.z.string().parse("x"));`);
	const old = join(scratch, "node_modules", "zod");
	const exports = {};
	for (const subpath of zodSubpaths) {
		mkdirSync(join(old, subpath), { recursive: true });
		writeFileSync(join(old, subpath, "index.js"), "export const z = { string: () => ({ parse: (v) => v }) }; export const version = { major: 4, minor: 0, patch: 0 };");
		exports[`./${subpath}`] = `./${subpath}/index.js`;
	}
	writeFileSync(join(old, "package.json"), JSON.stringify({ name: "zod", version: "3.25.76", exports }));
	if (nested) {
		const tool = join(sdk, "node_modules", "nested-tool");
		mkdirSync(tool, { recursive: true });
		writeFileSync(join(tool, "package.json"), JSON.stringify({ name: "nested-tool", type: "module", main: "index.js" }));
		writeFileSync(join(tool, "index.js"), 'import * as z from "zod/v4"; console.log(z.version);');
	}
	return scratch;
}

function probe(scratch, contents) {
	return build({
		...commonBuildOptions(),
		// A rejected probe reports through the error; esbuild's own copy of it is noise in the test log.
		logLevel: "silent",
		stdin: { contents, loader: "js", resolveDir: scratch, sourcefile: "probe.js" },
		write: false,
	});
}

function bundledScratchZod(result) {
	return Object.keys(result.metafile.inputs).some((input) => input.includes("senpi-bundle-zod-") && input.includes("/zod/"));
}

describe("zod single copy plugin", () => {
	it("redirects MCP SDK zod subpath imports to the coding-agent zod whatever the hoisted layout", async () => {
		const scratch = hoistedLayout({ sdkImport: "zod/v4" });
		try {
			const result = await probe(scratch, 'import "@modelcontextprotocol/sdk";');
			assert.equal(bundledScratchZod(result), false);
			assert.doesNotMatch(result.outputFiles[0].text, STALE_CORE);
		} finally {
			rmSync(scratch, { force: true, recursive: true });
		}
	});

	it("fails the build instead of falling back to the hoisted copy when the pinned zod cannot serve an SDK import", async () => {
		// Given: the SDK imports a zod subpath the hoisted copy exports and the pinned 4.6.7 does not
		const scratch = hoistedLayout({ sdkImport: "zod/not-in-the-pinned-copy", zodSubpaths: ["not-in-the-pinned-copy"] });
		try {
			await assert.rejects(
				() => probe(scratch, 'import "@modelcontextprotocol/sdk";'),
				(error) => error.errors.some((message) => message.text.includes("zod/not-in-the-pinned-copy")),
			);
		} finally {
			rmSync(scratch, { force: true, recursive: true });
		}
	});

	it("leaves a package nested under the SDK's own node_modules on the zod its layout selects", async () => {
		const scratch = hoistedLayout({ sdkImport: "zod/v4", nested: true });
		try {
			const result = await probe(scratch, 'import "./node_modules/@modelcontextprotocol/sdk/node_modules/nested-tool/index.js";');
			assert.equal(bundledScratchZod(result), true);
			assert.match(result.outputFiles[0].text, STALE_CORE);
		} finally {
			rmSync(scratch, { force: true, recursive: true });
		}
	});

	it("names the SDK's own modules and nothing under its nested node_modules", () => {
		assert.equal(isMcpSdkOwnModule("/r/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"), true);
		assert.equal(isMcpSdkOwnModule("C:\\r\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\types.js"), true);
		assert.equal(isMcpSdkOwnModule("/r/node_modules/@modelcontextprotocol/sdk/node_modules/zod-helper/index.js"), false);
		assert.equal(isMcpSdkOwnModule("/r/node_modules/@modelcontextprotocol/sdk/node_modules/@modelcontextprotocol/sdk/dist/x.js"), true);
		assert.equal(isMcpSdkOwnModule("/r/node_modules/@modelcontextprotocol/sdk-extra/dist/x.js"), false);
		assert.equal(isMcpSdkOwnModule("/r/packages/coding-agent/dist/core/mcp.js"), false);
	});
});
