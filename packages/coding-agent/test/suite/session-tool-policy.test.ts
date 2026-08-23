import { describe, expect, it } from "vitest";
import {
	applySessionToolPolicyToProviderPayload,
	SESSION_TOOL_POLICY_ENTRY_TYPE,
} from "../../src/core/session-tool-policy.ts";

describe("session tool policy provider enforcement", () => {
	it("removes provider-native tools after extension payload transforms", () => {
		// Given
		const entries = [
			{
				type: "custom" as const,
				customType: SESSION_TOOL_POLICY_ENTRY_TYPE,
				data: { version: 1, tools: "disabled" },
			},
		];
		const payload = {
			model: "provider-model",
			messages: [],
			tools: [{ type: "web_search_20250305", name: "web_search" }],
			tool_choice: { type: "tool", name: "web_search" },
			parallel_tool_calls: true,
		};

		// When
		const transformed = applySessionToolPolicyToProviderPayload(entries, payload);

		// Then
		expect(transformed).toEqual({
			model: "provider-model",
			messages: [],
		});
		expect(payload.tools).toHaveLength(1);
	});

	it("preserves payload identity when tools are allowed", () => {
		// Given
		const payload = { tools: [{ type: "function", name: "read" }] };

		// When
		const transformed = applySessionToolPolicyToProviderPayload([], payload);

		// Then
		expect(transformed).toBe(payload);
	});
});
