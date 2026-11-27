import { describe, expect, it, vi } from "vitest";
import type { McpFormRequest, McpFormResolved, McpFormSettled } from "../../src/core/mcp-form-types.ts";
import type { McpPresenterSecretFrame } from "../../src/modes/rpc/secret-sealed.ts";
import { McpFormGroup } from "../../src/modes/rpc/mcp-presenter-form-group.ts";

type Frame = McpFormRequest | McpFormResolved | McpFormSettled | McpPresenterSecretFrame;

describe("MCP form group latch (D11 S3-3b)", () => {
	it("the group latch admits and records one outcome even when a second claim reaches it", async () => {
		const admit = vi.fn();
		const frames: Frame[] = [];
		const group = new McpFormGroup(
			{
				operationId: "operation",
				inputId: "input",
				round: 0,
				server: { label: "server", source: "user" },
				message: "message",
				schema: { type: "object", properties: {} },
				operationSignal: new AbortController().signal,
				presentationSignal: new AbortController().signal,
				deadlineMs: 100,
			},
			{ clock: { now: () => 0, schedule: () => ({}), cancel: () => {} }, sessionId: "session", admit },
		);
		const join = (dialogId: string) =>
			group.join({
				envelope: {
					sessionId: "session",
					bindingEpoch: "b",
					attachmentEpoch: "a",
					grantId: dialogId,
					dialogId,
					formRevision: "r",
				},
				current: () => true,
				remove: () => {},
				send: (frame) => frames.push(frame) > 0,
				negotiated: true,
				answeredBy: { principalKind: "inherited", presenterKind: "desktop" },
			});
		const first = join("first");
		const second = join("second");
		group.start();
		const accepted = {
			kind: "result",
			result: { action: "accept", content: {} },
			source: "presenter_action",
			humanAdmission: true,
		} as const;
		group.settle(accepted, first);
		group.settle({ ...accepted, result: { action: "decline" } }, second);
		group.terminate("operation_aborted");
		expect(await group.result).toEqual(accepted);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(frames.filter((frame) => frame.type === "mcp_form_settled")).toHaveLength(2);
		expect(
			frames
				.filter((frame) => frame.type === "mcp_form_resolved")
				.map((frame) => frame.type === "mcp_form_resolved" && frame.reason),
		).toEqual(["answered", "answered"]);
	});
});
