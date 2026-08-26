import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/api/cursor-agent/gen/agent_pb.ts";
import { stream as streamCursorAgent } from "../src/api/cursor-agent.ts";
import type { CursorAgentCompat, Model } from "../src/model.ts";

const neverAbortedSignal = new AbortController().signal;

function buildModel(
	id: string,
	baseUrl: string,
	compat?: CursorAgentCompat,
	upstreamModelId?: string,
): Model<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 300000,
		maxTokens: 64000,
		...(upstreamModelId ? { upstreamModelId } : {}),
		...(compat ? { compat } : {}),
	};
}

function serverMessage(update: ReturnType<typeof create<typeof InteractionUpdateSchema>>): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: { case: "interactionUpdate", value: update },
	});
	const payload = toBinary(AgentServerMessageSchema, message);
	const frame = Buffer.alloc(5 + payload.length);
	frame.writeUInt8(0, 0);
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	return serverMessage(
		create(InteractionUpdateSchema, {
			message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
		}),
	);
}

function turnEndedFrame(): Buffer {
	return serverMessage(
		create(InteractionUpdateSchema, { message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) } }),
	);
}

let server: http2.Http2Server | undefined;

async function captureRunRequest(
	model: Model<"cursor-agent">,
	options: Record<string, unknown>,
): Promise<ReturnType<typeof fromBinary<typeof AgentClientMessageSchema>>> {
	server = http2.createServer();
	let captured: ReturnType<typeof fromBinary<typeof AgentClientMessageSchema>> | undefined;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			if (captured !== undefined) return;
			const buffer = Buffer.concat(chunks);
			if (buffer.length < 5) return;
			const length = buffer.readUInt32BE(1);
			if (buffer.length < 5 + length) return;
			captured = fromBinary(AgentClientMessageSchema, buffer.subarray(5, 5 + length));
		});
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(textDeltaFrame("ok"));
		stream.write(turnEndedFrame());
		stream.end();
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server!.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const stream = streamCursorAgent(
		{ ...model, baseUrl },
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{ apiKey: "test-token", signal: neverAbortedSignal, ...options },
	);
	for await (const _event of stream) {
		void _event;
	}
	await stream.result();
	if (!captured) throw new Error("no client frame captured");
	return captured;
}

describe("cursor Run request reasoning rendering", () => {
	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = undefined;
		}
	});

	const fableCompat: CursorAgentCompat = {
		cursorReasoning: {
			capabilityId: "claude-fable-5",
			thinkingMode: true,
			representativeVariantId: "claude-fable-5-thinking-medium",
		},
	};

	it("renders an explicit selection as the catalog suffix variant id", async () => {
		const model = buildModel("claude-fable-5-thinking", "", fableCompat, "claude-fable-5-thinking-medium");
		const frame = await captureRunRequest(model, { thinkingSelection: { level: "low", source: "explicit" } });
		const request = frame.message.value as {
			requestedModel?: { modelId: string; maxMode: boolean; parameters: { id: string; value: string }[] };
		};
		expect(request.requestedModel?.modelId).toBe("claude-fable-5-thinking-low");
		expect(request.requestedModel?.parameters ?? []).toEqual([]);
	});

	it("keeps the legacy request shape byte-exact when no selection exists", async () => {
		const model = buildModel("gpt-5.5-medium", "");
		const withSelection = await captureRunRequest(model, {});
		const request = withSelection.message.value as {
			requestedModel?: { modelId: string; maxMode: boolean; parameters: { id: string; value: string }[] };
		};
		expect(request.requestedModel?.modelId).toBe("gpt-5.5-medium");
		expect(request.requestedModel?.parameters ?? []).toEqual([]);
	});

	it("routes no-selection grouped models through the representative variant id", async () => {
		const compat: CursorAgentCompat = {
			cursorReasoning: { capabilityId: "gpt-5.5", representativeVariantId: "gpt-5.5-medium" },
		};
		const model = buildModel("gpt-5.5", "", compat, "gpt-5.5-medium");
		const frame = await captureRunRequest(model, {});
		const request = frame.message.value as { requestedModel?: { modelId: string; parameters?: unknown[] } };
		expect(request.requestedModel?.modelId).toBe("gpt-5.5-medium");
		expect(request.requestedModel?.parameters ?? []).toEqual([]);
	});

	it("renders gpt off as the none suffix variant id", async () => {
		const compat: CursorAgentCompat = {
			cursorReasoning: { capabilityId: "gpt-5.5", representativeVariantId: "gpt-5.5-medium" },
		};
		const model = buildModel("gpt-5.5", "", compat, "gpt-5.5-medium");
		const frame = await captureRunRequest(model, { thinkingSelection: { level: "off", source: "explicit" } });
		const request = frame.message.value as {
			requestedModel?: { modelId: string; parameters: { id: string; value: string }[] };
		};
		expect(request.requestedModel?.modelId).toBe("gpt-5.5-none");
		expect(request.requestedModel?.parameters ?? []).toEqual([]);
	});

	it("keeps maxMode orthogonal to the suffix variant id", async () => {
		const compat: CursorAgentCompat = {
			cursorMaxMode: true,
			cursorReasoning: {
				capabilityId: "claude-fable-5",
				thinkingMode: false,
				representativeVariantId: "claude-fable-5-medium",
			},
		};
		const model = buildModel("claude-fable-5", "", compat, "claude-fable-5-medium");
		const frame = await captureRunRequest(model, { thinkingSelection: { level: "high", source: "explicit" } });
		const request = frame.message.value as {
			requestedModel?: { modelId: string; maxMode: boolean; parameters: { id: string; value: string }[] };
		};
		expect(request.requestedModel?.maxMode).toBe(true);
		expect(request.requestedModel?.modelId).toBe("claude-fable-5-high");
		expect(request.requestedModel?.parameters ?? []).toEqual([]);
	});
});
