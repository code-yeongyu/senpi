import { describe, expect, it, vi } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import { ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH } from "../../src/tool-call-middleware/protocols/anthropic-xml/stream-boundary.ts";
import { createAntmlInvokeRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/antml/recovery-stream.ts";
import { collectEventSnapshots, MetadataStreamHarness } from "./invoke-recovery-metadata-fixtures.ts";
import {
	bashTool,
	eventMessage,
	invoke,
	namespacedInvoke,
	runChunks,
	runText,
	toolEvents,
} from "./invoke-recovery-scenario-fixtures.ts";
import { textFrom } from "./invoke-recovery-stream-fixtures.ts";

describe("invoke recovery split and resource scenarios", () => {
	it("keeps bare and namespaced recovery stable across exhaustive split points", async () => {
		for (const input of [invoke, namespacedInvoke]) {
			for (let split = 0; split <= input.length; split += 1) {
				const { events, result } = await runChunks([input.slice(0, split), input.slice(split)]);
				expect(
					toolEvents(events).map((event) => event.type),
					`split ${split}`,
				).toEqual(["toolcall_start", "toolcall_delta", "toolcall_end"]);
				expect(result.content, `split ${split}`).toEqual([
					{ type: "toolCall", id: "recovered-antml-0", name: "Bash", arguments: { command: "echo recovered" } },
				]);
			}
		}
	});

	it.each([
		["bare", invoke, true],
		["namespaced", namespacedInvoke, true],
		[
			"unsupported namespace",
			'<foo:invoke name="Bash"><foo:parameter name="command">echo nope</foo:parameter></foo:invoke>',
			false,
		],
		["arbitrary tag", '<tool name="Bash"><parameter name="command">echo nope</parameter></tool>', false],
	] as const)("handles %s forms without generic tag inference", async (_label, input, recovered) => {
		const { events, result } = await runText(input);
		expect(toolEvents(events).length > 0).toBe(recovered);
		expect(result.content.some((block) => block.type === "toolCall")).toBe(recovered);
		if (!recovered) expect(textFrom(result)).toBe(input);
	});

	it("preserves byte-identical full usage on every event and terminal", async () => {
		const producer = new MetadataStreamHarness();
		const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [bashTool]);
		producer.start();
		const index = producer.startText({ type: "text", text: "", textSignature: "signed" });
		producer.textDelta(index, invoke);
		producer.endText(index);
		producer.finish();
		const events = await collectEventSnapshots(wrapped);
		const result = await wrapped.result();
		const expected = JSON.stringify(result.usage);
		for (const event of events) expect(JSON.stringify(eventMessage(event).usage)).toBe(expected);
	});

	it("bounds recovery buffers and scan work", () => {
		const onError = vi.fn();
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
		const opening = '<invoke name="';
		const overflow = opening + "x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - opening.length);
		const events = [...parser.feed(overflow), ...parser.feed(invoke), ...parser.finish()];
		expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
			protocol: "antml",
			retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
		});
		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "toolcall_end")).toEqual([
			expect.objectContaining({ arguments: { command: "echo recovered" } }),
		]);
	});
});
