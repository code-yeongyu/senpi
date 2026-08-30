import { describe, expect, it } from "vitest";
import {
	isNativeSelfRuntime,
	jsRuntimeInfo,
	jsRuntimeLabel,
	runtimesFromAvailability,
} from "../src/extension/runtime-info.ts";
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

	it("reports native when the bun runtime is the compiled binary itself", () => {
		expect(jsRuntimeInfo({ node: "26.7.0", bun: "1.4.0" }, "/Users/dev/.omo/binary-runtime/omo", true)).toEqual({
			name: "native",
			version: "1.4.0",
			path: "/Users/dev/.omo/binary-runtime/omo",
		});
	});

	it("keeps the bun name when the runtime is a stock bun install", () => {
		expect(jsRuntimeInfo({ node: "26.7.0", bun: "1.4.0" }, "/opt/bun/bin/bun", false)).toEqual({
			name: "bun",
			version: "1.4.0",
			path: "/opt/bun/bin/bun",
		});
	});

	it("never reports native without the bun marker", () => {
		expect(jsRuntimeInfo({ node: "26.7.0" }, "/usr/local/bin/node", true)).toEqual({
			name: "node",
			version: "26.7.0",
			path: "/usr/local/bin/node",
		});
	});
});

describe("isNativeSelfRuntime", () => {
	it("trusts the compiled-host signal even when the module loads from a disk sidecar", () => {
		expect(
			isNativeSelfRuntime({
				bunVersion: "1.4.0",
				hostCompiledBinary: true,
				moduleUrl: "file:///Users/dev/node_modules/@code-yeongyu/senpi-codemode/src/extension/runtime-info.ts",
			}),
		).toBe(true);
	});

	it("ignores the compiled-host signal without the bun marker", () => {
		expect(
			isNativeSelfRuntime({ bunVersion: undefined, hostCompiledBinary: true, moduleUrl: "file:///x/y.ts" }),
		).toBe(false);
	});

	it("detects the bun virtual filesystem in the module url of a compiled binary", () => {
		expect(isNativeSelfRuntime({ bunVersion: "1.4.0", moduleUrl: "file:///$bunfs/root/runtime-info.ts" })).toBe(true);
	});

	it("detects windows virtual filesystem markers, raw and url-encoded", () => {
		expect(isNativeSelfRuntime({ bunVersion: "1.4.0", moduleUrl: "file:///B:/~BUN/root/runtime-info.ts" })).toBe(
			true,
		);
		expect(isNativeSelfRuntime({ bunVersion: "1.4.0", moduleUrl: "file:///B:/%7EBUN/root/runtime-info.ts" })).toBe(
			true,
		);
	});

	it("stays false for stock bun runs loading modules from disk", () => {
		expect(isNativeSelfRuntime({ bunVersion: "1.4.0", moduleUrl: "file:///Users/dev/src/runtime-info.ts" })).toBe(
			false,
		);
	});

	it("stays false when a stock bun disk path merely contains a marker segment", () => {
		expect(
			isNativeSelfRuntime({ bunVersion: "1.4.0", moduleUrl: "file:///tmp/$bunfs/project/runtime-info.ts" }),
		).toBe(false);
		expect(
			isNativeSelfRuntime({ bunVersion: "1.4.0", moduleUrl: "file:///Users/dev/~BUN/root/runtime-info.ts" }),
		).toBe(false);
		expect(
			isNativeSelfRuntime({ bunVersion: "1.4.0", moduleUrl: "file:///Users/dev/%7EBUN/root/runtime-info.ts" }),
		).toBe(false);
	});

	it("stays false under node even when the module url carries a marker", () => {
		expect(isNativeSelfRuntime({ bunVersion: undefined, moduleUrl: "file:///$bunfs/root/runtime-info.ts" })).toBe(
			false,
		);
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
