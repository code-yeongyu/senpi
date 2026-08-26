import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const builtinRoot = join(packageRoot, "src", "core", "extensions", "builtin");

describe("claude sdk oauth naming boundary", () => {
	it("renames the internal provider path without renaming the upstream package", () => {
		expect(existsSync(join(builtinRoot, "claude-sdk-oauth", "index.ts"))).toBe(true);
		expect(existsSync(join(builtinRoot, "claude-agent-sdk", "index.ts"))).toBe(false);

		const packageJson = readFileSync(join(packageRoot, "package.json"), "utf8");
		expect(packageJson).toContain('"@anthropic-ai/claude-agent-sdk":');
		expect(packageJson).not.toContain('"@anthropic-ai/claude-sdk-oauth"');
	});
});
