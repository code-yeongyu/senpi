import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadOnlyAuthStorage } from "../../../src/core/auth-storage.ts";
import { updateMcpServerConfig } from "../../../src/core/extensions/builtin/mcp/config-edit.ts";
import { validateConfig } from "../../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ModelConfig } from "../../../src/core/model-config.ts";
import { referenceRoot } from "./3858-reference-support.ts";

// #3858: union acceptance stays limited to explicit credential positions.
describe("reference schema boundaries", () => {
	const ref = { $env: "SYNTHETIC_3858" };
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => files.close());

	it.each([
		["args", { args: [ref] }],
		["env", { env: { TOKEN: ref } }],
		["headers", { headers: { Authorization: ref } }],
	])("accepts MCP %s references", (_name, fields) => {
		expect(validateConfig.Check({ mcpServers: { demo: { command: "fixture", ...fields } } })).toBe(true);
	});

	it.each([
		["apiKey", { apiKey: ref }],
		["headers", { headers: { Authorization: ref } }],
		["model apiKey", { models: [{ id: "demo", apiKey: ref }] }],
		["model headers", { models: [{ id: "demo", headers: { Authorization: ref } }] }],
		["override headers", { modelOverrides: { demo: { headers: { Authorization: ref } } } }],
		["policy slots", { credentials: { slots: { secondary: { value: ref } } } }],
	])("accepts models.json %s references", (_name, fields) => {
		const content = JSON.stringify({ providers: { fixture: { baseUrl: "https://example.invalid", ...fields } } });
		expect(ModelConfig.validationError(content, join(files.root, "models.json"))).toBeUndefined();
	});

	it.each(["baseUrl", "model baseUrl", "url", "command", "cwd", "oauth"])("refuses references in %s", (position) => {
		if (position === "baseUrl" || position === "model baseUrl") {
			const fields = position === "baseUrl" ? { baseUrl: ref } : { models: [{ id: "demo", baseUrl: ref }] };
			expect(
				ModelConfig.validationError(JSON.stringify({ providers: { fixture: fields } }), "models.json"),
			).toBeDefined();
			return;
		}
		const fields = position === "oauth" ? { oauth: { clientId: ref } } : { [position]: ref };
		expect(validateConfig.Check({ mcpServers: { demo: { command: "fixture", ...fields } } })).toBe(false);
	});

	// #3858 storage contract: an MCP config edit rewrites raw JSON and keeps every reference object intact.
	it("keeps MCP reference objects through a config edit", () => {
		const declared = { command: "fixture", env: { TOKEN: ref }, args: [{ $concat: ["--key=", { $file: "~/k" }] }] };
		const path = files.file("mcp.json", JSON.stringify({ mcpServers: { demo: declared } }));
		expect(updateMcpServerConfig(path, "demo", { enabled: false })).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { demo: { ...declared, enabled: false } } });
	});

	it("leaves opaque extraBody objects uninspected", () => {
		const content = JSON.stringify({ providers: { fixture: { extraBody: { $file: 42, nested: ref } } } });
		expect(ModelConfig.validationError(content, "models.json")).toBeUndefined();
	});

	it("validates pool key objects in the read-only auth reader", async () => {
		const path = files.file(
			"auth.json",
			JSON.stringify({ fixture: { type: "api_key", key: "valid", accounts: [{ name: "bad", key: { $env: 3 } }] } }),
		);
		await expect(new ReadOnlyAuthStorage(path).read("fixture")).rejects.toMatchObject({
			name: "ConfigReferenceError",
			reason: "malformed",
		});
	});
});
