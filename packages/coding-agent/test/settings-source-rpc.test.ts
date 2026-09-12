import { basename } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("settings source RPC event", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("publishes the selected JSONC source when the RPC connection starts", async () => {
		harness = await createHarness({
			fileSettings: true,
			settingsFileName: "settings.jsonc",
			settingsContent: '{ // comment\n "theme": "dark",\n}',
		});
		const chunks: string[] = [];
		const sink: RpcConnectionSink = {
			writeRaw: (chunk) => chunks.push(chunk),
			waitForBackpressure: async () => {},
		};
		const runtimeHost = {
			session: harness.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const handler = createRpcConnectionHandler(runtimeHost, sink);

		await handler.ready;
		const records = chunks
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const selected = records.filter((record) => record.type === "settings_source_selected");

		expect(selected).toHaveLength(1);
		expect(basename(String(selected[0].path))).toBe("settings.jsonc");
		expect(selected[0]).toMatchObject({
			format: "jsonc",
			reason: "explicit-jsonc",
			scope: "global",
		});
		await handler.dispose();
	});
});
