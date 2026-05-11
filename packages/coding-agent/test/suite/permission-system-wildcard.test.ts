import { describe, expect, it } from "vitest";
import { Wildcard } from "../../src/core/extensions/builtin/permission-system/wildcard.js";

describe("permission-system wildcard matching", () => {
	it("matches exact strings", () => {
		expect(Wildcard.match("read", "read")).toBe(true);
		expect(Wildcard.match("read", "write")).toBe(false);
	});

	it("matches star patterns", () => {
		expect(Wildcard.match("anthropic-web-search", "anthropic-*")).toBe(true);
		expect(Wildcard.match("read", "*")).toBe(true);
		expect(Wildcard.match("", "*")).toBe(true);
	});

	it("matches question-mark patterns", () => {
		expect(Wildcard.match("read", "rea?")).toBe(true);
		expect(Wildcard.match("read", "re??")).toBe(true);
		expect(Wildcard.match("read", "re???")).toBe(false);
	});

	it("backtracks mixed star and literal patterns", () => {
		expect(Wildcard.match("hello-world-test", "hello*test")).toBe(true);
		expect(Wildcard.match("hello-world-test", "hello?foo*")).toBe(false);
	});
});
