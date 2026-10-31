// senpi#3566: on win32 the tool child is held in a Job Object through bun:ffi, so `--tool-runtime child` runs on a Bun
// host and is refused with a typed reason on a Node-run host - from the flag, the env, and a session built directly.
import { describe, expect, it } from "vitest";
import {
	resolveToolRuntime,
	TOOL_RUNTIME_UNSUPPORTED_HOST,
	toolRuntimeHostRefusal,
} from "../../src/cli/tool-runtime.ts";
import { createHarness } from "./harness.ts";

describe("tool runtime child on win32", () => {
	it("is refused from the flag and from the env on a host without bun:ffi, and allowed elsewhere", () => {
		const fromFlag = resolveToolRuntime({ toolRuntime: "child" }, {}, "win32", () => false);
		expect(fromFlag.ok).toBe(false);
		expect(fromFlag.ok ? "" : fromFlag.message).toMatch(new RegExp(`^${TOOL_RUNTIME_UNSUPPORTED_HOST}: `));
		const fromEnv = resolveToolRuntime({}, { SENPI_TOOL_RUNTIME: "child" }, "win32", () => false);
		expect(fromEnv.ok ? "" : fromEnv.message).toMatch(new RegExp(`^${TOOL_RUNTIME_UNSUPPORTED_HOST}: `));
		expect(resolveToolRuntime({ toolRuntime: "in-process" }, {}, "win32")).toEqual({ ok: true, value: "in-process" });
		expect(resolveToolRuntime({ toolRuntime: "child" }, {}, "darwin")).toEqual({ ok: true, value: "child" });
		expect(resolveToolRuntime({ toolRuntime: "child" }, {}, "linux")).toEqual({ ok: true, value: "child" });
	});

	it("refuses a session built directly with toolRuntime child", async () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await expect(createHarness({ toolRuntime: "child" })).rejects.toMatchObject({
				code: TOOL_RUNTIME_UNSUPPORTED_HOST,
			});
		} finally {
			if (original !== undefined) Object.defineProperty(process, "platform", original);
		}
		expect(process.platform).not.toBe("win32");
	});

	it("allows child on a win32 host with bun:ffi and refuses it without", () => {
		expect(resolveToolRuntime({ toolRuntime: "child" }, {}, "win32", () => true)).toEqual({
			ok: true,
			value: "child",
		});
		expect(toolRuntimeHostRefusal("child", "win32", () => true)).toBeUndefined();
		expect(toolRuntimeHostRefusal("child", "win32", () => false)).toMatch(
			new RegExp(`^${TOOL_RUNTIME_UNSUPPORTED_HOST}: `),
		);
	});

	it("names the reason and the way out", () => {
		expect(toolRuntimeHostRefusal("child", "win32", () => false)).toContain("use in-process");
		expect(toolRuntimeHostRefusal("in-process", "win32")).toBeUndefined();
	});
});
