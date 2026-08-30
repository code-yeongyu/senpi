import { describe, expect, it } from "vitest";
import { formatRuntimeBadge, minifyPath } from "../src/tool/runtime-label.ts";

describe("formatRuntimeBadge", () => {
	it("shows version and home-contracted path for subprocess kernels", () => {
		expect(
			formatRuntimeBadge(
				"py",
				{ name: "python", version: "3.14.7", path: "/Users/dev/.venv/bin/python3" },
				"/Users/dev",
			),
		).toBe("3.14.7, ~/.venv/bin/python3");
	});

	it("prefixes the runtime name for js so bun and node are distinguishable", () => {
		expect(
			formatRuntimeBadge("js", { name: "bun", version: "1.4.0", path: "/usr/local/bin/bun" }, "/Users/dev"),
		).toBe("bun 1.4.0, /usr/local/bin/bun");
	});

	it("labels the native self-hosted runtime like any js runtime", () => {
		expect(
			formatRuntimeBadge("js", { name: "native", version: "1.4.0", path: "/Users/dev/.omo/bin/omo" }, "/Users/dev"),
		).toBe("native 1.4.0, ~/.omo/bin/omo");
	});

	it("falls back to a version-only badge when no path is known", () => {
		expect(formatRuntimeBadge("py", { name: "python", version: "3.12.4" }, "/Users/dev")).toBe("3.12.4");
	});
});

describe("minifyPath", () => {
	it("keeps short absolute paths untouched", () => {
		expect(minifyPath("/usr/bin/ruby", "/Users/dev")).toBe("/usr/bin/ruby");
	});

	it("contracts the home directory to ~", () => {
		expect(minifyPath("/Users/dev/bin/julia", "/Users/dev")).toBe("~/bin/julia");
	});

	it("middle-truncates long paths keeping the head and trailing segments", () => {
		const minified = minifyPath("/opt/homebrew/Cellar/node-runtime/26.7.0_1/libexec/bin/node", "/Users/dev");
		expect(minified.startsWith("/opt/")).toBe(true);
		expect(minified).toContain("\u2026");
		expect(minified.endsWith("/bin/node")).toBe(true);
		expect([...minified].length).toBeLessThanOrEqual(40);
	});

	it("hard-truncates a single oversized segment", () => {
		const longSegment = "x".repeat(80);
		const minified = minifyPath(`/tmp/${longSegment}`, "/Users/dev");
		expect([...minified].length).toBeLessThanOrEqual(40);
		expect(minified).toContain("\u2026");
	});
});
