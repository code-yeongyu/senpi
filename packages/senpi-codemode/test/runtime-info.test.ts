import { describe, expect, it } from "vitest";
import { jsRuntimeInfo, jsRuntimeLabel, runtimesFromAvailability } from "../src/extension/runtime-info.ts";
import type { InterpreterAvailability, LanguageAvailability } from "../src/interpreters/detect.ts";

const unavailable: LanguageAvailability = { enabled: false, detected: { ok: false } };

function availability(overrides: Partial<InterpreterAvailability>): InterpreterAvailability {
	return {
		py: unavailable,
		js: { enabled: true, detected: { ok: true, path: "node", version: "26.7.0" } },
		rb: unavailable,
		jl: unavailable,
		...overrides,
	};
}

describe("jsRuntimeInfo", () => {
	it("reports bun with the bun version when running under bun", () => {
		expect(jsRuntimeInfo({ node: "26.7.0", bun: "1.4.0" }, "/opt/bun/bin/bun")).toEqual({
			name: "bun",
			version: "1.4.0",
			path: "/opt/bun/bin/bun",
		});
	});

	it("reports node when no bun marker exists", () => {
		expect(jsRuntimeInfo({ node: "26.7.0" }, "/usr/local/bin/node")).toEqual({
			name: "node",
			version: "26.7.0",
			path: "/usr/local/bin/node",
		});
	});
});

describe("jsRuntimeLabel", () => {
	it("labels bun runtimes", () => {
		expect(jsRuntimeLabel({ node: "26.7.0", bun: "1.4.0" })).toBe("bun 1.4.0");
	});

	it("labels node runtimes", () => {
		expect(jsRuntimeLabel({ node: "26.7.0" })).toBe("node 26.7.0");
	});
});

describe("runtimesFromAvailability", () => {
	it("maps detected interpreters preferring the resolved absolute path", () => {
		const js = { name: "node", version: "26.7.0", path: "/usr/local/bin/node" };
		const runtimes = runtimesFromAvailability(
			availability({
				py: {
					enabled: true,
					detected: {
						ok: true,
						path: "python3",
						version: "3.14.7",
						resolvedPath: "/opt/homebrew/bin/python3",
					},
				},
			}),
			js,
		);
		expect(runtimes.py).toEqual({ name: "python", version: "3.14.7", path: "/opt/homebrew/bin/python3" });
		expect(runtimes.js).toEqual(js);
	});

	it("falls back to the probe command when no absolute path resolved and skips unavailable languages", () => {
		const js = { name: "node", version: "26.7.0", path: "/usr/local/bin/node" };
		const runtimes = runtimesFromAvailability(
			availability({ rb: { enabled: true, detected: { ok: true, path: "ruby", version: "3.3.6" } } }),
			js,
		);
		expect(runtimes.rb).toEqual({ name: "ruby", version: "3.3.6", path: "ruby" });
		expect(runtimes.py).toBeUndefined();
		expect(runtimes.jl).toBeUndefined();
	});
});
