import { readFile } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const promptText = "nonce isolation prompt";
const answerText = "an answer streamed in a few deltas";

/** Observe the actual legacy sink bytes, preserving its writes and backpressure. */
function captureLegacyBytes(): string[] {
	const lines: string[] = [];
	const register = SessionEventWriter.prototype.registerConnection;
	vi.spyOn(SessionEventWriter.prototype, "registerConnection").mockImplementation(function (
		this: SessionEventWriter,
		id,
		connection,
		options,
	) {
		register.call(
			this,
			id,
			{
				...connection,
				writeRaw: (line) => {
					lines.push(line);
					connection.writeRaw(line);
				},
			},
			options,
		);
	});
	return lines;
}

function expectNoEpoch(bytes: string, nonce: string): void {
	expect(bytes).not.toContain("recoveryEpoch");
	expect(bytes).not.toContain(nonce);
}

async function expectIsolatedBytes(file: string, lines: readonly string[], nonce: string): Promise<void> {
	const persisted = await readFile(file, "utf8");
	const legacy = lines.join("");
	// Non-vacuity: both raw surfaces must contain the completed conversation.
	for (const bytes of [persisted, legacy]) {
		expect(bytes).toContain(promptText);
		expect(bytes).toContain(answerText);
		expect(bytes).toContain('"role":"user"');
		expect(bytes).toContain('"role":"assistant"');
		expectNoEpoch(bytes, nonce);
	}
	expect(legacy).toContain('"type":"message_end"');
}

// Part of #4272, RULING-24: the journal's epoch must never become a persisted entry field.
it("keeps the real in-process epoch out of persisted JSONL and public legacy bytes", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const lines = captureLegacyBytes();
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("legacy");
	const opened = dataOf(await client.request({ type: "open_session", cwd: host.cwd }));
	const sessionId = String(opened.sessionId);
	const entry: RpcSessionEntry | undefined = admissions.mock.results.findLast(
		(result) => result.type === "return",
	)?.value;
	const lane = entry?.acceptance;
	const session = entry?.runtime?.session;
	if (!lane || !session) throw new Error("no real in-process lane");
	const file = session.sessionManager.getSessionFile();
	if (!file) throw new Error("no persisted session file");
	const nonce = lane.recoveryEpoch;
	expect(nonce).not.toBe("");
	const terminalEpochs: (string | undefined)[] = [];
	const stop = session.subscribe((event) => {
		if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "assistant"))
			terminalEpochs.push(recoveryCarrier(event)?.epoch);
	});
	try {
		const done = client.waitFor((record) => record.type === "agent_idle");
		host.faux.setResponses([fauxAssistantMessage(answerText, { timestamp: 1 })]);
		dataOf(await client.request({ type: "prompt", sessionId, message: promptText }));
		await done;
		await host.writer.flush();
		// Verify this was the producer's actual epoch, not an unrelated random string.
		expect(terminalEpochs).toEqual([nonce, nonce]);
		await expectIsolatedBytes(file, lines, nonce);
	} finally {
		stop();
	}
}, 90000);

it("keeps the real worker epoch out of persisted JSONL and public legacy bytes", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const lines = captureLegacyBytes();
	const host = await workerAcceptanceHost();
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		const file = host.registry.peek(sessionId)?.sessionPath;
		if (!lane || !file) throw new Error("no real worker lane or persisted session file");
		const nonce = lane.recoveryEpoch;
		expect(nonce).not.toBe("");
		const done = host.next("nonce isolation turn idle", (record) => record.type === "agent_idle");
		expect((await host.request({ type: "prompt", sessionId, message: promptText })).success).toBe(true);
		await done;
		await host.writer.flush();
		const terminals = host.frames.filter(({ frame }) => {
			if (!("type" in frame.record) || frame.record.type !== "message_end") return false;
			const role = Reflect.get(Object("message" in frame.record ? frame.record.message : undefined), "role");
			return role === "user" || role === "assistant";
		});
		// Internal worker carriers must contain the nonce that the public sink excludes.
		expect(terminals.map(({ frame }) => frame.recovery?.epoch)).toEqual([nonce, nonce]);
		await expectIsolatedBytes(file, lines, nonce);
		expect(host.failures).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 90000);
