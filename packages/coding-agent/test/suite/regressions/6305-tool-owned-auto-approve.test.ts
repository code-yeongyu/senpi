import { describe, expect, it } from "vitest";
import { toolOwnedPermissionRequests } from "../../../src/core/extensions/builtin/permission-system/parsers.ts";

const tool = (autoApproveAsk: boolean) => ({
	name: "reply_tool",
	permissionParser: (input: Record<string, unknown>) => [
		{
			permission: "reply_tool",
			patterns: [String(input.target)],
			always: [String(input.target)],
			...(autoApproveAsk ? { autoApproveAsk: true as const } : {}),
		},
	],
});

describe("senpi#6305 a tool-owned request keeps its autoApproveAsk", () => {
	it("passes autoApproveAsk through, so the ask is approved while allow and deny rules still match the request", () => {
		const [request] = toolOwnedPermissionRequests([tool(true)] as never, "reply_tool", { target: "s-1" }, "/") ?? [];
		expect(request).toEqual({ permission: "reply_tool", patterns: ["s-1"], always: ["s-1"], autoApproveAsk: true });
	});

	it("adds nothing for a tool that does not ask for it", () => {
		const [request] = toolOwnedPermissionRequests([tool(false)] as never, "reply_tool", { target: "s-1" }, "/") ?? [];
		expect(request).toEqual({ permission: "reply_tool", patterns: ["s-1"], always: ["s-1"] });
	});
});
