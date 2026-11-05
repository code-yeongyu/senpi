import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as publicEntry from "../src/index.ts";

// senpi#4349: guard the package boundary consumed by publish.mjs, not a test-only resolution alias.
describe("internal agent channel stays off the public entry", () => {
	it("does not publish an internal-events subpath", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.exports).not.toHaveProperty("./internal-events");
	});
	it("D4 the main entry does not export subscribeInternalAgent", () => {
		expect(Object.keys(publicEntry)).not.toContain("subscribeInternalAgent");
		expect(Object.keys(publicEntry)).not.toContain("dispatchInternalAgent");
	});
	// Architecture contract: a process-global registry would bypass construction-time custody.
	it("keeps channel ownership out of global registries, including module initialization", () => {
		const source = readFileSync(new URL("../src/internal-events.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/\bSymbol\s*\.\s*for\s*\(|\bglobalThis\b/u);
	});
});
