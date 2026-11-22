// senpi#3566: the host alone says where tool work runs. Under `child` it advertises the placements the tool child
// serves, and a negotiated `tool_runtime:*` / `placement:*` capability can never add a second answer.
import { describe, expect, it } from "vitest";
import { isHostOwnedToolRuntimeCapability, toolRuntimeCapabilities } from "../../src/cli/tool-runtime.ts";
import { multiSessionHostCapabilities } from "../../src/modes/rpc/host-capabilities.ts";

const owned = (capabilities: readonly string[]) => capabilities.filter(isHostOwnedToolRuntimeCapability);

describe("tool runtime capabilities", () => {
	it("advertises the tool child's placements only under child, and the offload API in both runtimes", () => {
		expect(toolRuntimeCapabilities("in-process")).toEqual(["tool_runtime:in-process", "offload_api"]);
		expect(toolRuntimeCapabilities("child")).toEqual([
			"tool_runtime:child",
			"placement:launch-barrier",
			"placement:job-policy",
			"placement:hostcall",
			"placement:offload",
			"placement:terminal",
			"offload_api",
		]);
	});

	it("drops negotiated tool_runtime and placement entries so the host's own answer is the only one", () => {
		const negotiated = ["tool_runtime:child", "placement:offload", "offload_api", "custom:keep"];
		const inProcess = multiSessionHostCapabilities({ warm: false, toolRuntime: "in-process", negotiated });
		expect(owned(inProcess)).toEqual(["tool_runtime:in-process", "offload_api"]);
		expect(inProcess).toContain("custom:keep");
		const child = multiSessionHostCapabilities({ warm: false, toolRuntime: "child", negotiated });
		expect(owned(child)).toEqual([
			"tool_runtime:child",
			"placement:launch-barrier",
			"placement:job-policy",
			"placement:hostcall",
			"placement:offload",
			"placement:terminal",
			"offload_api",
		]);
	});
});
