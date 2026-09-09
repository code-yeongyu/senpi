/**
 * `get_media` on-demand media fetch + `media_placeholders` capability advertisement.
 *
 * A connection that opted into `media_placeholders` receives `image_ref` stubs instead
 * of inline base64 inside tool results; this command is how it fetches the original
 * block back. The lookup is the durable session record first
 * (`sessionManager.getEntries()` message entries with `role: "toolResult"`), then the
 * live agent message window (`session.messages`) for results that have not been
 * persisted yet.
 *
 * Harness: the in-process classic RPC harness (`test/fixtures/rpc-classic-harness.ts`,
 * same mocks as `test/rpc-classic-compat.test.ts`) — commands are driven through the
 * injected stdin line handler and every emitted line is captured at the
 * `writeRawStdout` boundary. The capability advertisement is asserted in BOTH modes:
 * classic (`connection-handler.ts`) through the harness, multi
 * (`session-command-router.ts`) through a direct router call as in
 * `test/rpc-multi-session.test.ts`.
 */

import { setMaxListeners } from "node:events";
import type { ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../src/modes/rpc/custom-capability.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { RPC_ERROR_MEDIA_NOT_FOUND } from "../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { createFakeRuntimeHost, type ParsedOutputLine, parseOutputLines } from "./fixtures/rpc-classic-harness.ts";

const rpcIo = {
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
};

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (chunk: string) => {
		rpcIo.outputLines.push(chunk);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

interface StartedRpc {
	lineHandler: (line: string) => void;
	session: AgentSession;
	cleanup: () => Promise<void>;
}

async function startClassicRpc(): Promise<StartedRpc> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const host = await createFakeRuntimeHost({ withSwapSession: false, withAuth: true, responseDelayMs: 0 });
	void runRpcMode(host.runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		session: host.runtimeHost.session,
		cleanup: host.cleanup,
	};
}

function sendCommand(lineHandler: (line: string) => void, command: Record<string, unknown>): string {
	const id = `c-${Math.random().toString(36).slice(2, 10)}`;
	lineHandler(JSON.stringify({ id, ...command }));
	return id;
}

function responseFor(id: string): ParsedOutputLine | undefined {
	return parseOutputLines(rpcIo.outputLines).find((record) => record.id === id && record.type === "response");
}

async function awaitResponse(id: string): Promise<ParsedOutputLine> {
	await vi.waitFor(() => expect(responseFor(id)).toBeDefined());
	return responseFor(id)!;
}

function toolResult(toolCallId: string, content: ToolResultMessage["content"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read_image",
		content,
		isError: false,
		timestamp: Date.now(),
	};
}

describe("get_media", () => {
	beforeEach(() => {
		setMaxListeners(0, process);
		setMaxListeners(0, process.stdin);
	});
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("returns the original image block from a persisted toolResult entry", async () => {
		const { lineHandler, session, cleanup } = await startClassicRpc();
		try {
			const image: ImageContent = { type: "image", data: PNG_BASE64, mimeType: "image/png" };
			session.sessionManager.appendMessage(
				toolResult("call_persisted", [{ type: "text", text: "screenshot" }, image]),
			);

			const id = sendCommand(lineHandler, { type: "get_media", toolCallId: "call_persisted", contentIndex: 1 });
			const response = await awaitResponse(id);

			expect(response).toMatchObject({
				type: "response",
				command: "get_media",
				success: true,
				data: {
					toolCallId: "call_persisted",
					contentIndex: 1,
					content: { type: "image", data: PNG_BASE64, mimeType: "image/png" },
				},
			});
		} finally {
			await cleanup();
		}
	});

	it("falls back to the live message window for a not-yet-persisted toolResult", async () => {
		const { lineHandler, session, cleanup } = await startClassicRpc();
		try {
			const image: ImageContent = { type: "image", data: PNG_BASE64, mimeType: "image/jpeg" };
			// Live agent state only: nothing appended to the session manager.
			session.messages.push(toolResult("call_live", [image]));

			const id = sendCommand(lineHandler, { type: "get_media", toolCallId: "call_live", contentIndex: 0 });
			const response = await awaitResponse(id);

			expect(response).toMatchObject({
				success: true,
				data: { content: { type: "image", data: PNG_BASE64, mimeType: "image/jpeg" } },
			});
		} finally {
			await cleanup();
		}
	});

	it("answers media_not_found for an unknown toolCallId", async () => {
		const { lineHandler, cleanup } = await startClassicRpc();
		try {
			const id = sendCommand(lineHandler, { type: "get_media", toolCallId: "call_missing", contentIndex: 0 });
			const response = await awaitResponse(id);

			expect(response).toMatchObject({
				command: "get_media",
				success: false,
				error: RPC_ERROR_MEDIA_NOT_FOUND,
				errorCode: RPC_ERROR_MEDIA_NOT_FOUND,
			});
		} finally {
			await cleanup();
		}
	});

	it("answers media_not_found when contentIndex is not an image block", async () => {
		const { lineHandler, session, cleanup } = await startClassicRpc();
		try {
			session.sessionManager.appendMessage(
				toolResult("call_text", [
					{ type: "text", text: "no image here" },
					{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
				]),
			);

			const textIndex = sendCommand(lineHandler, { type: "get_media", toolCallId: "call_text", contentIndex: 0 });
			const outOfRange = sendCommand(lineHandler, { type: "get_media", toolCallId: "call_text", contentIndex: 9 });

			expect(await awaitResponse(textIndex)).toMatchObject({
				success: false,
				error: RPC_ERROR_MEDIA_NOT_FOUND,
				errorCode: RPC_ERROR_MEDIA_NOT_FOUND,
			});
			expect(await awaitResponse(outOfRange)).toMatchObject({
				success: false,
				error: RPC_ERROR_MEDIA_NOT_FOUND,
				errorCode: RPC_ERROR_MEDIA_NOT_FOUND,
			});
		} finally {
			await cleanup();
		}
	});

	it("advertises media_placeholders in get_protocol_info in classic mode", async () => {
		const { lineHandler, cleanup } = await startClassicRpc();
		try {
			const id = sendCommand(lineHandler, { type: "get_protocol_info" });
			const response = await awaitResponse(id);
			const data = response.data as { capabilities: string[]; mode: string };

			expect(data.mode).toBe("classic");
			expect(data.capabilities).toContain(MEDIA_PLACEHOLDERS_CAPABILITY);
		} finally {
			await cleanup();
		}
	});

	it("advertises media_placeholders in get_protocol_info in multi mode", async () => {
		const registry = { list: () => [] } as never;
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: "/tmp" });

		const response = await router.handle({ id: "probe", type: "get_protocol_info" });
		const data = (response as { data: { capabilities: string[]; mode: string } }).data;

		expect(data.mode).toBe("multi");
		expect(data.capabilities).toContain(MEDIA_PLACEHOLDERS_CAPABILITY);
	});

	it("RpcClient.getMedia sends the command and unwraps the content block", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		const content: ImageContent = { type: "image", data: PNG_BASE64, mimeType: "image/png" };
		(client as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command) => {
			sent.push(command);
			return {
				type: "response",
				command: "get_media",
				success: true,
				data: { toolCallId: "call_abc", contentIndex: 1, content },
			};
		};

		await expect(client.getMedia("call_abc", 1)).resolves.toEqual(content);
		expect(sent).toEqual([{ type: "get_media", toolCallId: "call_abc", contentIndex: 1 }]);
	});
});
