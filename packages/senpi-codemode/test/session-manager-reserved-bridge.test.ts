import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL, RESERVED_SCHEMA_TOOL } from "../src/bridge/reserved.ts";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import {
	type BridgeEndpoint,
	type CodemodeSessionManager,
	createCodemodeSessionManager,
} from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";

// Subprocess kernels (py/rb/jl) reach the host only over the bridge HTTP /call route,
// so the reserved helper names must be routed there exactly as the in-process JS
// kernel path routes them in tool/cell-handler.ts.
const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v20" } },
	py: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

type RecordedCall = { readonly toolName: string; readonly params: unknown };

class UnknownToolError extends Error {
	readonly name = "UnknownToolError";
	readonly code = "unknown_tool";

	constructor(toolName: string) {
		super(`Unknown tool ${toolName}. Active tools: read, bash, task, task_output`);
	}
}

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function endpointOf(manager: CodemodeSessionManager): BridgeEndpoint {
	const endpoint = manager.bridgeEndpoint?.();
	if (!endpoint) throw new Error("session manager exposed no bridge endpoint");
	return endpoint;
}

async function postCall(port: number, token: string, toolName: string, args: unknown): Promise<unknown> {
	const response = await fetch(`http://127.0.0.1:${port}/call`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ callId: `call-${toolName}`, toolName, args }),
	});
	return await response.json();
}

describe("codemode session manager reserved bridge routing", () => {
	let manager: CodemodeSessionManager | undefined;
	let dir = "";

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	async function startManager(calls: RecordedCall[]): Promise<CodemodeSessionManager> {
		dir = mkdtempSync(join(tmpdir(), "codemode-reserved-"));
		return await createCodemodeSessionManager({
			sessionId: "s",
			cwd: dir,
			settings: defaultCodemodeSettings,
			availability,
			listTools: () => [{ name: "read", description: "read a file", parameters: { type: "object" } }],
			executeTool: Object.assign(
				async (toolName: string, params: unknown): Promise<AgentToolResult<unknown>> => {
					// The real agent session rejects reserved names: they are bridge-only
					// helpers and are never registered as agent tools.
					if (toolName.startsWith("__")) throw new UnknownToolError(toolName);
					calls.push({ toolName, params });
					return textResult("DELEGATED_RESULT", { task_id: "st_reserved", status: "completed" });
				},
				{ isToolAvailable: (name: string) => name === "task" || name === "task_output" },
			),
			complete: async () => {
				throw new Error("completion is not exercised in this test");
			},
		});
	}

	// Regression: the bridge /call handler forwarded every toolName straight to
	// executeTool, so agent() from a python cell failed with
	// "Unknown tool __agent__. Active tools: ...".
	it("routes __agent__ through the agent bridge to the task tool", async () => {
		const calls: RecordedCall[] = [];
		manager = await startManager(calls);
		const bridge = endpointOf(manager);

		const reply = await postCall(bridge.port, bridge.token, RESERVED_AGENT_TOOL, {
			prompt: "summarize the diff",
			agent: "explore",
		});

		expect(reply).toEqual({ ok: true, value: { text: "DELEGATED_RESULT" } });
		expect(calls).toEqual([
			{
				toolName: "task",
				params: { prompt: "summarize the diff", subagent_type: "explore", run_in_background: false },
			},
		]);
	});

	it("routes __output__ through the output bridge to the task_output tool", async () => {
		const calls: RecordedCall[] = [];
		manager = await startManager(calls);
		const bridge = endpointOf(manager);

		const reply = await postCall(bridge.port, bridge.token, RESERVED_OUTPUT_TOOL, { ids: ["st_reserved"] });

		expect(reply).toEqual({ ok: true, value: "DELEGATED_RESULT" });
		expect(calls).toEqual([{ toolName: "task_output", params: { task_id: "st_reserved", mode: "full" } }]);
	});

	it("answers __schema__ from the tool catalog without touching executeTool", async () => {
		const calls: RecordedCall[] = [];
		manager = await startManager(calls);
		const bridge = endpointOf(manager);

		const reply = await postCall(bridge.port, bridge.token, RESERVED_SCHEMA_TOOL, { name: "read" });

		expect(reply).toEqual({
			ok: true,
			value: { name: "read", description: "read a file", parameters: { type: "object" } },
		});
		expect(calls).toEqual([]);
	});

	it("still forwards ordinary tool names straight to executeTool", async () => {
		const calls: RecordedCall[] = [];
		manager = await startManager(calls);
		const bridge = endpointOf(manager);

		const reply = await postCall(bridge.port, bridge.token, "read", { path: "a.txt" });

		expect(reply).toMatchObject({ ok: true });
		expect(calls).toEqual([{ toolName: "read", params: { path: "a.txt" } }]);
	});

	it("marshals ordinary tool results into the same {text, images} shape the JS kernel receives", async () => {
		const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
		dir = mkdtempSync(join(tmpdir(), "codemode-reserved-"));
		manager = await createCodemodeSessionManager({
			sessionId: "s",
			cwd: dir,
			settings: defaultCodemodeSettings,
			availability,
			listTools: () => [],
			executeTool: async () => ({
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: pngBase64, mimeType: "image/png" },
				],
				details: {},
			}),
			complete: async () => {
				throw new Error("completion is not exercised in this test");
			},
		});
		const bridge = endpointOf(manager);

		const reply = await postCall(bridge.port, bridge.token, "read", { path: "shot.png" });

		expect(reply).toEqual({
			ok: true,
			value: {
				text: "Read image file [image/png]",
				details: undefined,
				images: [{ mimeType: "image/png", dataBase64: pngBase64 }],
				hasError: false,
			},
		});
	});
});
