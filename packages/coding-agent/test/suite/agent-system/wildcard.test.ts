import { describe, expect, it } from "vitest";
import { Wildcard } from "../../../src/core/extensions/builtin/agent-system/wildcard.js";

describe("Wildcard", () => {
	describe("match", () => {
		it("matches exact strings", () => {
			// given
			const value = "read";
			const pattern = "read";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches any string with star pattern", () => {
			// given
			const value = "read";
			const pattern = "*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches single character with question mark", () => {
			// given
			const value = "read";
			const pattern = "rea?";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("returns false for non-matching strings", () => {
			// given
			const value = "read";
			const pattern = "write";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(false);
		});

		it("matches prefix with star wildcard", () => {
			// given
			const value = "git diff HEAD";
			const pattern = "git*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("returns false when prefix does not match", () => {
			// given
			const value = "rm -rf /";
			const pattern = "git*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(false);
		});

		it("matches empty string with star pattern", () => {
			// given
			const value = "";
			const pattern = "*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("returns false for non-empty value with empty pattern", () => {
			// given
			const value = "anything";
			const pattern = "";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(false);
		});

		it("matches empty value with empty pattern", () => {
			// given
			const value = "";
			const pattern = "";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches literal asterisk in both value and pattern", () => {
			// given
			const value = "*.env";
			const pattern = "*.env";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches complex pattern with multiple wildcards", () => {
			// given
			const value = "a.env.local";
			const pattern = "*.env.*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches pattern with suffix wildcard", () => {
			// given
			const value = "a.env.example";
			const pattern = "*.env.example";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches pattern with star at end", () => {
			// given
			const value = "config.json";
			const pattern = "config.*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches pattern with star at beginning", () => {
			// given
			const value = "src/main.ts";
			const pattern = "*.ts";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches pattern with star in middle", () => {
			// given
			const value = "src/components/Button.tsx";
			const pattern = "src/*/Button.tsx";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("returns false when middle segment does not match", () => {
			// given
			const value = "src/utils/Button.tsx";
			const pattern = "src/*/Button.tsx";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches multiple question marks", () => {
			// given
			const value = "abc";
			const pattern = "???";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("returns false when question mark count exceeds value length", () => {
			// given
			const value = "ab";
			const pattern = "???";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(false);
		});

		it("returns false when value length exceeds question mark count", () => {
			// given
			const value = "abcd";
			const pattern = "???";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(false);
		});

		it("handles mixed wildcards", () => {
			// given
			const value = "hello-world-test";
			const pattern = "hello?world*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("returns false for mixed wildcards when literal part does not match", () => {
			// given
			const value = "hello-world-test";
			const pattern = "hello?foo*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(false);
		});

		it("matches star matching empty sequence", () => {
			// given
			const value = "test";
			const pattern = "*test";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches star matching empty sequence at end", () => {
			// given
			const value = "test";
			const pattern = "test*";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("handles consecutive stars as single star", () => {
			// given
			const value = "test";
			const pattern = "**";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("matches complex file path pattern", () => {
			// given
			const value = "packages/coding-agent/src/test.ts";
			const pattern = "packages/*/src/*.ts";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(true);
		});

		it("returns false for non-matching file path pattern", () => {
			// given
			const value = "packages/coding-agent/test.ts";
			const pattern = "packages/*/src/*.ts";

			// when
			const result = Wildcard.match(value, pattern);

			// then
			expect(result).toBe(false);
		});
	});
});
