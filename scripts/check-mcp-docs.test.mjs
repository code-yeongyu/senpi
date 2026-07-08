// Guard (todo 43): every field in the SHIPPED MCP TypeBox schema must appear
// as a `### \`field\`` heading in docs/mcp.md, so schema drift breaks CI
// instead of silently rotting the reference. Parses the schema SOURCE (the
// object-literal keys) rather than importing TS, keeping this a plain
// node --test script like its siblings.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaSource = readFileSync(
	join(root, "packages", "coding-agent", "src", "core", "extensions", "builtin", "mcp", "config-schema.ts"),
	"utf8",
);
const docs = readFileSync(join(root, "packages", "coding-agent", "docs", "mcp.md"), "utf8");

function literalKeys(blockName) {
	const start = schemaSource.indexOf(`const ${blockName} = Type.Object(`);
	assert.notEqual(start, -1, `schema block ${blockName} not found`);
	const open = schemaSource.indexOf("{", start);
	let depth = 0;
	let end = open;
	for (let i = open; i < schemaSource.length; i += 1) {
		if (schemaSource[i] === "{") depth += 1;
		if (schemaSource[i] === "}") depth -= 1;
		if (depth === 0) {
			end = i;
			break;
		}
	}
	const body = schemaSource.slice(open + 1, end);
	// Top-level keys only: lines at one-tab indent ending with a Type.* value.
	return [...body.matchAll(/^\t\t(\w+): /gm)].map((match) => match[1]);
}

test("docs/mcp.md documents every shipped server field", () => {
	const missing = literalKeys("ServerSchema").filter((key) => !docs.includes(`### \`${key}\``));
	assert.deepEqual(missing, [], `undocumented server fields: ${missing.join(", ")}`);
});

test("docs/mcp.md documents every shipped settings field", () => {
	const missing = literalKeys("SettingsSchema").filter((key) => !docs.includes(`### \`${key}\``));
	assert.deepEqual(missing, [], `undocumented settings fields: ${missing.join(", ")}`);
});

test("docs/mcp.md keeps the full-disable instructions", () => {
	assert.ok(docs.includes('"disabledBuiltinExtensions": ["mcp"]'), "disable instructions missing");
});

test("docs/mcp.md makes no url-mode elicitation claim", () => {
	assert.ok(!/url[- ]mode/i.test(docs), "docs must not advertise url-mode elicitation (v1 is form-only)");
});
