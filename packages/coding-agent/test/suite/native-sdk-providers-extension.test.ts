import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";

describe("native SDK built-in providers", () => {
	it("registers Codex, Kimi, and Grok provider extensions", () => {
		const ids = builtinExtensions.map((extension) => extension.id);

		expect(ids).toContain("codex-sdk");
		expect(ids).toContain("kimi-sdk");
		expect(ids).toContain("grok-sdk");
		expect(ids).toContain("claude-sdk-oauth");
	});
});
