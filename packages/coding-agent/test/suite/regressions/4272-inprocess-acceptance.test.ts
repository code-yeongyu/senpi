import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { recoveryCarrier, SessionRecoveryIdentity } from "../../../src/core/session-recovery-identity.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { createRpcSessionBinding } from "../../../src/modes/rpc/session-binding.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import type { RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { createStructuredHarness } from "../structured-lane-sdk-harness.ts";
import { scriptProvider, textReply } from "../structured-lane-support.ts";
import { expectSameBytesExceptDeliveryStamp } from "../../helpers/rpc-delivery-stamp.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Seen = {
	readonly type: string;
	readonly role: unknown;
	readonly clientMessageId: unknown;
	readonly sequence: number;
	readonly correlation: number | null;
	readonly activeMessageId: string | null;
	readonly turnId: string | null;
};

function field(record: object, key: string): unknown {
	return key in record ? Reflect.get(record, key) : undefined;
}

// Part of #4272, T5 + ruling 10 Q6 + ruling 12: the real binding hands each record to the lane before the writer.
it("T5 sequences in-process records in producer order, correlation before its content, with legacy bytes unchanged", async () => {
	vi.stubEnv(FLAG, "1");
	const scope = new ProviderScope();
	const harness = await runWithProviderScope(scope, () => createStructuredHarness());
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("This fixture does not replace sessions");
		},
	);
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	const entry: RpcSessionEntry = {
		scope,
		runtime,
		acceptance: lane,
		state: "open",
		kind: "interactive",
		context: {},
		profile: { cwd: harness.tempDir },
		cwd: harness.tempDir,
		attachments: 1,
		lastCommandAt: 0,
		lifecycleMutex: Promise.resolve(),
	};
	const seen: Seen[] = [];
	const expected: string[] = [];
	const actual: string[] = [];
	const ended = Promise.withResolvers<void>();
	class ObservingWriter extends SessionEventWriter {
		override enqueue(sessionId: string, record: object): boolean {
			const root = lane.freeze();
			lane.release(root);
			seen.push({
				type: String(field(record, "type")),
				role: field(Object(field(record, "message")), "role"),
				clientMessageId: field(record, "clientMessageId"),
				sequence: root.sequence,
				correlation: root.correlation?.sequence ?? null,
				activeMessageId: root.activeMessageId,
				turnId: root.turnId,
			});
			// The pre-S04 reference bytes: the record normalized and tagged exactly as the writer received it.
			expected.push(`${JSON.stringify({ ...JSON.parse(JSON.stringify(record)), sessionId })}\n`);
			const accepted = super.enqueue(sessionId, record);
			if (field(record, "type") === "agent_end") ended.resolve();
			return accepted;
		}
	}
	const writer = new ObservingWriter(() => {});
	writer.registerConnection("client", { writeRaw: (line) => actual.push(line), waitForBackpressure: async () => {} });
	writer.attachConnectionToSession("client", "session");
	const binding = await createRpcSessionBinding("session", entry, writer, () => {});
	try {
		scriptProvider(harness, [textReply("answer")]);
		await writer.withConnection("client", () =>
			binding.handle({ type: "prompt", id: "p1", message: "question", clientMessageId: "c-1" }),
		);
		const deadline = setTimeout(() => ended.reject(new Error("no agent_end")), 20_000);
		await ended.promise.finally(() => clearTimeout(deadline));
		await writer.flush();

		const sequenced = seen.filter((record) => record.type !== "response");
		for (const [index, record] of seen.entries()) {
			const previous = seen[index - 1]?.sequence ?? 0;
			if (record.type === "response") expect(record.sequence, "a response takes no sequence").toBe(previous);
			else expect(record.sequence, `${record.type} is sequenced in order`).toBeGreaterThanOrEqual(previous);
		}
		const firstCorrelated = seen.findIndex((record) => record.clientMessageId === "c-1");
		const correlated = seen[firstCorrelated];
		expect(correlated?.type, "the flushed turn prefix carries the correlation first").toBe("turn_start");
		expect(seen.slice(0, firstCorrelated).every((record) => record.correlation === null)).toBe(true);
		expect(correlated?.correlation, "the correlation transition takes the sequence before its record").toBe(
			(correlated?.sequence ?? 0) - 1,
		);
		const userStart = seen.findIndex((record) => record.type === "message_start" && record.role === "user");
		expect(userStart).toBeGreaterThan(firstCorrelated);
		expect(seen[firstCorrelated + 1]?.sequence, "the turn's first content follows its correlation").toBe(
			(correlated?.sequence ?? 0) + 1,
		);
		const turnPrefix = seen.slice(firstCorrelated, userStart + 1);
		expect(turnPrefix.every((record) => record.clientMessageId === "c-1")).toBe(true);
		for (const [index, record] of turnPrefix.entries())
			if (index > 0) expect(record.sequence).toBe((turnPrefix[index - 1]?.sequence ?? 0) + 1);

		const assistant = sequenced.filter(
			(record) =>
				record.role === "assistant" && (record.type === "message_start" || record.type === "message_update"),
		);
		const assistantId = assistant[0]?.activeMessageId;
		expect(assistantId).toMatch(UUID);
		expect(assistant.every((record) => record.activeMessageId === assistantId)).toBe(true);
		expect(seen[userStart]?.activeMessageId).toMatch(UUID);
		expect(seen[userStart]?.activeMessageId).not.toBe(assistantId);
		const turn = seen.findIndex((record) => record.type === "turn_start");
		const turnEnd = seen.findIndex((record) => record.type === "turn_end");
		const turnId = seen[turn]?.turnId;
		expect(turnId).toMatch(UUID);
		expect(seen.slice(turn, turnEnd).every((record) => record.turnId === turnId)).toBe(true);
		expect(seen.at(-1)?.turnId, "agent_end closes the turn").toBeNull();

		expectSameBytesExceptDeliveryStamp(actual, expected);
		expect(actual.some((line) => /"(messageId|turnId|sessionEpoch)":/.test(line))).toBe(false);
	} finally {
		await binding.dispose();
		writer.unregisterConnection("client");
		runtime.releaseSessionHold();
		harness.cleanup();
		await scope.close();
	}
}, 60_000);

// Part of #4272, ruling 12 Q1: ids are minted at the start, or at a terminal with no start, and never invented.
it("mints opaque message and turn ids at their start, at a start-less terminal, and never for an ownerless record", () => {
	const identity = new SessionRecoveryIdentity();
	const orphanUpdate = { type: "message_update", message: { role: "assistant" } };
	identity.observe(orphanUpdate);
	expect(recoveryCarrier(orphanUpdate), "an update with no start has no owner").toBeUndefined();
	const directEnd = { type: "message_end", message: { role: "assistant" } };
	identity.observe(directEnd);
	expect(recoveryCarrier(directEnd)?.messageId).toMatch(UUID);
	const start = { type: "message_start", message: { role: "assistant" } };
	const update = { type: "message_update", message: { role: "assistant" } };
	const end = { type: "message_end", message: { role: "assistant" } };
	for (const event of [start, update, end]) identity.observe(event);
	expect(recoveryCarrier(start)?.messageId).toMatch(UUID);
	expect(recoveryCarrier(start)?.messageId).not.toBe(recoveryCarrier(directEnd)?.messageId);
	expect(recoveryCarrier(end)).toEqual(recoveryCarrier(start));
	expect(recoveryCarrier(update)).toEqual(recoveryCarrier(start));

	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	expect(lane.accept({ type: "queue_update" }, undefined), "a pass-through record takes no sequence").toBeUndefined();
	expect(lane.accept({ type: "agent_start" }, undefined)?.turnId).toBeNull();
	const directTurnEnd = lane.accept({ type: "turn_end" }, undefined);
	expect(directTurnEnd?.turnId, "a turn_end with no turn_start mints at that record").toMatch(UUID);
	const tool = lane.accept({ type: "tool_execution_start" }, undefined);
	expect(tool?.turnId, "a turn with records but no turn_start mints at its first record").toMatch(UUID);
	expect(tool?.turnId).not.toBe(directTurnEnd?.turnId);
	expect(lane.accept({ type: "turn_end" }, undefined)?.turnId).toBe(tool?.turnId);
	const user = lane.accept({ type: "message_start", message: { role: "user" } }, undefined);
	expect(user, "no carrier, no invented message id; outside a turn, no turn id").toMatchObject({
		messageId: null,
		turnId: null,
		sequence: 5,
	});
});

// Part of #4272, review MEDIUM-2: the host keeps each accepted append's id, never a serialized copy of its content.
it("R21.1 R21.2 keeps persisted host retention per accepted append bounded: entry ids only, no stringify on the host loop", async () => {
	vi.stubEnv(FLAG, "1");
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-ids-"));
	const manager = SessionManager.create(dir, dir);
	await manager.persistHeaderNow();
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	const baseline = lane.freeze();
	lane.release(baseline);
	const content = "x".repeat(256 * 1024);
	const appends = 64;
	const entries = Array.from({ length: appends }, (_, index) => ({
		type: "message",
		id: `e${index}`,
		parentId: index === 0 ? null : `e${index - 1}`,
		message: { role: "toolResult", content },
	}));
	for (const entry of entries) manager.appendCustomEntry("retention", entry);
	const transitions = manager.drainTranscript();
	const clientMessages = [{ clientMessageId: "c-1" }, { clientMessageId: "c-2", clientTurnId: "t-1" }];
	const correlation = { clientMessageId: "c-2", clientTurnId: "t-1", clientMessages };
	lane.accept({ type: "turn_start", ...correlation }, undefined);
	const before = lane.freeze();
	lane.release(before);
	const stringify = vi.spyOn(JSON, "stringify");
	lane.applyTranscript(transitions);
	const refs = entries.map((entry) => {
		lane.accept(
			{
				type: "message_update",
				message: { role: "assistant", content },
				...correlation,
				clientMessages: clientMessages.map((identity) => ({ ...identity })),
			},
			undefined,
		);
		return lane.accept({ type: "entry_appended", entry }, undefined);
	});
	const calls = stringify.mock.calls.length;
	stringify.mockRestore();
	expect(calls, "no serialization for appends or message_update records while client correlation stands").toBe(0);
	expect(refs.every((ref) => ref?.historyVersion === baseline.transcript.historyVersion + appends)).toBe(true);
	// Mirror trimming mutates the manager's entry objects later; the root names entries, it does not alias them.
	for (const entry of entries) entry.parentId = "trimmed";
	const root = lane.freeze();
	expect(root.correlation, "shallow-equal client identities keep the same transition").toBe(before.correlation);
	expect(root.transcript.count).toBe(appends + 1);
	expect(root.transcript.leafId).toBe(manager.getLeafId());
	expect(root.transcript.tail.retainedBytes).toBe(0);
	const retained = JSON.stringify(root.transcript).length;
	expect(retained, "retention is the ids, independent of entry size").toBeLessThan(appends * 16 + 1024);
	lane.release(root);
	manager.dispose();
	await rm(dir, { recursive: true, force: true });
});

// Part of #4272, ruling 10: the accepted baseline exists before the router admits a connection to the session.
it.each([true, false])("bootstrap precedes in-process admission (flag on: %s)", async (flag) => {
	if (flag) vi.stubEnv(FLAG, "1");
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-bootstrap-"));
	const rig = createInProcessRig(dir);
	const original = SessionEventWriter.prototype.attachConnectionToSession;
	const atAdmission: Array<{ readonly sessionEpoch: string; readonly sequence: number } | null> = [];
	vi.spyOn(SessionEventWriter.prototype, "attachConnectionToSession").mockImplementation(function (
		this: SessionEventWriter,
		id: string,
		sessionId: string,
	) {
		const lane = rig.registry.peek(sessionId)?.acceptance;
		const root = lane?.freeze();
		if (lane && root) lane.release(root);
		atAdmission.push(root ? { sessionEpoch: root.sessionEpoch, sequence: root.sequence } : null);
		original.call(this, id, sessionId);
	});
	try {
		const opened = await rig.open("caller", { cwd: dir, sessionPath: join(dir, "session.jsonl") });
		expect(opened?.success, JSON.stringify(opened)).toBe(true);
		expect(atAdmission.length).toBeGreaterThan(0);
		if (flag) expect(atAdmission[0]).toEqual({ sessionEpoch: expect.stringMatching(UUID), sequence: 0 });
		else expect(atAdmission[0], "flag off: no lane").toBeNull();
	} finally {
		rig.teardown.release();
		await rig[Symbol.asyncDispose]();
		await rm(dir, { recursive: true, force: true });
	}
});
