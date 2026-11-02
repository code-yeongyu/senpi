// senpi#3566: an ensure that asks for a tool runtime never reuses a host that runs another one. The requested runtime
// becomes a required capability, so the existing capability rule (fallback/refuse) applies; no flag, no new requirement.
import { describe, expect, it } from "vitest";
import { REQUIRED_HOST_CAPABILITIES } from "../../src/modes/rpc/host-decision.ts";
import { ensureClient, requestedToolRuntime } from "../../src/modes/rpc/host-ensure-client.ts";

describe("ensureHost and the requested tool runtime", () => {
	it("reads --tool-runtime from hostArgs in both spellings, ignoring unknown values", () => {
		expect(requestedToolRuntime(["--tool-runtime", "child"])).toEqual(["tool_runtime:child"]);
		expect(requestedToolRuntime(["--listen", "x", "--tool-runtime=in-process"])).toEqual(["tool_runtime:in-process"]);
		expect(requestedToolRuntime(["--tool-runtime", "bogus"])).toEqual([]);
		expect(requestedToolRuntime(["--tool-runtime"])).toEqual([]);
		expect(requestedToolRuntime([])).toEqual([]);
	});

	it("requires the requested runtime, and nothing new without the flag", () => {
		expect(ensureClient({ socket: "s", hostArgs: ["--tool-runtime", "child"] }, false).requiredCapabilities).toEqual([
			...REQUIRED_HOST_CAPABILITIES,
			"tool_runtime:child",
		]);
		expect(ensureClient({ socket: "s" }, false).requiredCapabilities).toEqual([...REQUIRED_HOST_CAPABILITIES]);
	});
});
