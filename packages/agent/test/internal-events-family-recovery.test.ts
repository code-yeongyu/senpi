import { afterEach, describe, expect, it } from "vitest";
import { stream as streamDevin } from "../../ai/src/api/devin-agent.ts";
import { getAssistantCapture } from "../../ai/src/utils/assistant-capture.ts";
import { closeStubServers, frame, MODEL, serveEdge, trailer } from "../../ai/test/devin-agent-stream-harness.ts";
import { Agent } from "../src/agent.ts";
import { type OrderedAgentRecord, createInternalAgentChannel } from "../src/internal-events.ts";

afterEach(closeStubServers);

async function channel(modelId: string): Promise<OrderedAgentRecord[]> {
	const { baseUrl } = await serveEdge({
		chat: (_req, res) => {
			res.writeHead(200, { "content-type": "application/connect+proto" });
			res.write(frame({ messageId: "m1", deltaThinking: "plan", deltaSignature: "s1" }));
			res.write(frame({ messageId: "m1", deltaText: "done" }));
			res.write(trailer());
			res.end();
		},
	});
	const model = { ...MODEL, id: modelId, baseUrl };
	const internalChannel = createInternalAgentChannel();
	const agent = new Agent({
		internalChannel,
		initialState: { model },
		streamFn: (_model, context, options) => streamDevin(model, context, { ...options, apiKey: "session-abc" }),
	});
	const records: OrderedAgentRecord[] = [];
	const unsubscribe = internalChannel.subscribe((record) => {
		records.push(record);
	});
	await agent.prompt("fixture");
	unsubscribe();
	return records;
}

function recordShapes(records: OrderedAgentRecord[]): string[] {
	return records.map((record) => {
		if ("progress" in record) {
			const { startedAt, endedAt, ...rest } = record.progress as { startedAt?: number; endedAt?: number };
			const timing = [startedAt === undefined ? "" : "startedAt", endedAt === undefined ? "" : "endedAt"].join("");
			return `progress ${JSON.stringify(rest)} ${timing}`;
		}
		const event = record.event;
		const kind = event.type === "message_update" ? `${event.type}:${event.assistantMessageEvent.type}` : event.type;
		return `${kind} carrier=${getAssistantCapture(event) !== undefined}`;
	});
}

describe("empty-assistant recovery and a real S02a-2 family #4272", () => {
	it("delivers a Claude id's Devin records exactly as an unwrapped id's", async () => {
		const unwrapped = recordShapes(await channel("swe-1-6"));
		expect(unwrapped).toContain(
			`progress ${JSON.stringify({ type: "message_block_metadata", contentIndex: 0, thinkingSignature: "s1" })} `,
		);
		expect(unwrapped).toContain("message_update:thinking_start carrier=true");
		const wrapped = recordShapes(await channel("claude-sonnet-4-5"));
		// The Devin fixture's first frame opens the thinking block, so its signature names block 0 behind the wrapper too.
		expect(wrapped).toContain(
			`progress ${JSON.stringify({ type: "message_block_metadata", contentIndex: 0, thinkingSignature: "s1" })} `,
		);
		expect(wrapped).toEqual(unwrapped);
	});
});
