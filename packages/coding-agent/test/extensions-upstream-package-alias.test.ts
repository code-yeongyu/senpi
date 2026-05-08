import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";

describe("upstream package name alias for extension loader", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-upstream-alias-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves runtime imports from @code-yeongyu/senpi", async () => {
		// given a third-party extension that imports a runtime helper
		// from the upstream package name (the case for any pi-extension
		// authored against pi-mono and run under senpi)
		const extCode = `
			import { defineTool } from "@code-yeongyu/senpi";
			import { Type } from "typebox";

			const upstreamTool = defineTool({
				name: "upstream_aliased_tool",
				label: "Upstream Aliased Tool",
				description: "Verifies @code-yeongyu/senpi resolves under senpi",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});

			export default function (pi) {
				pi.registerTool(upstreamTool);
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "upstream-import.ts"), extCode);

		// when the extension is discovered and loaded
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		// then it must load without "Cannot find module" errors and
		// register the tool, proving the alias maps the upstream name
		// to the senpi runtime
		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.tools.has("upstream_aliased_tool")).toBe(true);
	});

	it("resolves runtime imports from the upstream @mariozechner package names", async () => {
		// given extensions installed from upstream pi packages still import
		// @mariozechner peer package names. Under senpi these must resolve to the
		// already-loaded senpi runtime instead of an extension-local duplicate.
		const extCode = `
			import { StringEnum } from "@mariozechner/pi-ai";
			import { Text } from "@mariozechner/pi-tui";
			import { defineTool } from "@mariozechner/pi-coding-agent";
			import { Type } from "typebox";

			const rendered = new Text("ok", 0, 0);
			const upstreamTool = defineTool({
				name: "mario_aliased_tool",
				label: "Mario Aliased Tool",
				description: StringEnum(["ok"]).type,
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: rendered.render(10).join("\\n") }] }),
			});

			export default function (pi) {
				pi.registerTool(upstreamTool);
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "mario-import.ts"), extCode);

		// when the extension is discovered and loaded
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		// then it must load without falling through to an extension-local
		// @mariozechner/pi-coding-agent install.
		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.tools.has("mario_aliased_tool")).toBe(true);
	});

	it("resolves type-only imports from @code-yeongyu/senpi", async () => {
		// given a third-party extension that uses a type-only import
		// (the most common shape for upstream-named imports). Type-only
		// imports erase at runtime but a missing alias still surfaces
		// when the bundler/transpiler eagerly resolves the specifier
		const extCode = `
			import type { ExtensionAPI } from "@code-yeongyu/senpi";
			import { Type } from "typebox";

			export default function (pi: ExtensionAPI) {
				pi.registerTool({
					name: "upstream_type_only_tool",
					label: "Upstream Type-only Tool",
					description: "Verifies type imports do not break load",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "upstream-type.ts"), extCode);

		// when the extension is loaded
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		// then it must register the tool with no errors
		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.tools.has("upstream_type_only_tool")).toBe(true);
	});
});
