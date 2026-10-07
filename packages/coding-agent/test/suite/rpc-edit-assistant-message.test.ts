import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import { RpcClient, RpcCommandError } from "../../src/modes/rpc/rpc-client.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { EditAssistantMessageResult } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];
type ListenerSnapshot = { stdinEnd: NodeListener[]; signals: Map<NodeJS.Signals, NodeListener[]> };

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previous] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previous.includes(listener)) process.off(signal, listener);
		}
	}
}

type ResponseLine = {
	id?: string;
	type: string;
	command: string;
	success: boolean;
	data?: EditAssistantMessageResult;
	error?: string;
	errorCode?: string;
};

function responses(): ResponseLine[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ResponseLine)
		.filter((line) => line.type === "response" && line.command === "edit_assistant_message");
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function isAssistantEntry(entry: { type: string; message?: { role: string } }): entry is SessionMessageEntry {
	return entry.type === "message" && entry.message?.role === "assistant";
}

let requestCounter = 0;

async function sendEdit(payload: {
	entryId: string;
	text: string;
	expectedLeafId?: string;
	summarize?: boolean;
	customInstructions?: string;
}): Promise<ResponseLine> {
	const id = `edit-${++requestCounter}`;
	rpcIo.lineHandler?.(JSON.stringify({ id, type: "edit_assistant_message", ...payload }));
	await vi.waitFor(() => expect(responses().some((line) => line.id === id)).toBe(true));
	const line = responses().find((r) => r.id === id);
	if (!line) throw new Error("response vanished");
	return line;
}

describe("RPC edit_assistant_message", () => {
	const harnesses: Harness[] = [];
	const snapshots: ListenerSnapshot[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (snapshots.length > 0) restoreListeners(snapshots.pop() as ListenerSnapshot);
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	async function startConversation(): Promise<Harness> {
		snapshots.push(takeListenerSnapshot());
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("The answer is 41."), fauxAssistantMessage("Anything else?")]);
		await harness.session.prompt("What is the answer?");
		await harness.session.prompt("Thanks");
		void runRpcMode(createRuntimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		return harness;
	}

	it("(a) edits the target under its original parent and reports the new leaf", async () => {
		const harness = await startConversation();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		if (!a1) throw new Error("expected an assistant entry");

		const line = await sendEdit({ entryId: a1.id, text: "The answer is 42." });

		expect(line.success).toBe(true);
		const data = line.data;
		if (data?.outcome !== "edited") throw new Error(`expected edited, got ${JSON.stringify(data)}`);
		expect(data.entry.parentId).toBe(a1.parentId);
		expect(data.leafId).toBe(data.entry.id);
		expect(harness.sessionManager.getLeafId()).toBe(data.entry.id);
		expect(data.summaryEntryId).toBeUndefined();
		const original = harness.sessionManager.getEntry(a1.id);
		if (!original || !isAssistantEntry(original)) throw new Error("original entry must survive");
		expect(getMessageText(original.message)).toBe("The answer is 41.");
	});

	it("(b) reports unchanged without appending when the text matches", async () => {
		const harness = await startConversation();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		if (!a1) throw new Error("expected an assistant entry");
		const leafBefore = harness.sessionManager.getLeafId();
		const countBefore = harness.sessionManager.getEntries().length;

		const line = await sendEdit({ entryId: a1.id, text: "  The answer is 41.\n" });

		expect(line.success).toBe(true);
		expect(line.data).toEqual({ outcome: "unchanged", leafId: leafBefore });
		expect(harness.sessionManager.getEntries().length).toBe(countBefore);
	});

	it("(c) rejects a stale expectedLeafId with errorCode stale_leaf and zero writes", async () => {
		const harness = await startConversation();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		if (!a1) throw new Error("expected an assistant entry");
		const countBefore = harness.sessionManager.getEntries().length;

		const line = await sendEdit({ entryId: a1.id, text: "The answer is 42.", expectedLeafId: "leaf-from-elsewhere" });

		expect(line.success).toBe(false);
		expect(line.errorCode).toBe("stale_leaf");
		expect(harness.sessionManager.getEntries().length).toBe(countBefore);
	});

	it("(d)(e)(f) maps not_assistant, not_found and empty to typed error codes", async () => {
		const harness = await startConversation();
		const entries = harness.sessionManager.getEntries();
		const [a1] = entries.filter(isAssistantEntry);
		if (!a1?.parentId) throw new Error("expected a parented assistant entry");

		const notAssistant = await sendEdit({ entryId: a1.parentId, text: "x" });
		const notFound = await sendEdit({ entryId: "no-such-entry", text: "x" });
		const empty = await sendEdit({ entryId: a1.id, text: "   " });

		expect([notAssistant.success, notFound.success, empty.success]).toEqual([false, false, false]);
		expect(notAssistant.errorCode).toBe("not_assistant");
		expect(notFound.errorCode).toBe("not_found");
		expect(empty.errorCode).toBe("empty");
	});

	it("(g) answers streaming while a response is in flight", async () => {
		const harness = await startConversation();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		if (!a1) throw new Error("expected an assistant entry");
		let midStream: ResponseLine | undefined;
		harness.setResponses([
			async () => {
				midStream = await sendEdit({ entryId: a1.id, text: "edited mid-stream" });
				return fauxAssistantMessage("streamed");
			},
		]);

		await harness.session.prompt("third");

		expect(midStream?.success).toBe(false);
		expect(midStream?.errorCode).toBe("streaming");
	});

	it("(h) two clients sharing one token: exactly one edited, one stale_leaf", async () => {
		const harness = await startConversation();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		const token = harness.sessionManager.getLeafId();
		if (!a1 || !token) throw new Error("expected an assistant entry and a leaf");

		const first = await sendEdit({ entryId: a1.id, text: "first window", expectedLeafId: token });
		const second = await sendEdit({ entryId: a1.id, text: "second window", expectedLeafId: token });

		expect(first.success).toBe(true);
		expect(first.data?.outcome).toBe("edited");
		expect(second.success).toBe(false);
		expect(second.errorCode).toBe("stale_leaf");
		const edited = harness.sessionManager
			.getEntries()
			.filter(isAssistantEntry)
			.map((e) => getMessageText(e.message));
		expect(edited).toContain("first window");
		expect(edited).not.toContain("second window");
	});

	it("(i) summarize=true parents the edited copy under the summary entry", async () => {
		const harness = await startConversation();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		if (!a1) throw new Error("expected an assistant entry");
		harness.setResponses([fauxAssistantMessage("Summary of the abandoned branch.")]);

		const line = await sendEdit({ entryId: a1.id, text: "The answer is 42.", summarize: true });

		expect(line.success).toBe(true);
		const data = line.data;
		if (data?.outcome !== "edited") throw new Error(`expected edited, got ${JSON.stringify(data)}`);
		expect(data.summaryEntryId).toBeDefined();
		expect(data.entry.parentId).toBe(data.summaryEntryId);
		const summary = harness.sessionManager.getEntry(data.summaryEntryId as string);
		expect(summary?.type).toBe("branch_summary");
	});

	it("(m) every persisted message is followed by entry_appended carrying its session entry id", async () => {
		const harness = await startConversation();
		rpcIo.outputLines = [];
		harness.setResponses([fauxAssistantMessage("Identity check.")]);
		await harness.session.prompt("Who are you?");

		const lines = rpcIo.outputLines
			.flatMap((line) => line.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						message?: { role: string };
						entry?: { id: string; type: string; message?: { role: string } };
					},
			);
		const persistedEnds = lines
			.map((line, index) => ({ line, index }))
			.filter(
				({ line }) =>
					line.type === "message_end" && (line.message?.role === "user" || line.message?.role === "assistant"),
			);
		expect(persistedEnds.length).toBe(2);
		const knownIds = new Set(harness.sessionManager.getEntries().map((e) => e.id));
		for (const { line, index } of persistedEnds) {
			const appended = lines.slice(index + 1).find((candidate) => candidate.type === "entry_appended");
			if (!appended?.entry) throw new Error(`no entry_appended after message_end(${line.message?.role})`);
			expect(appended.entry.type).toBe("message");
			expect(appended.entry.message?.role).toBe(line.message?.role);
			expect(knownIds.has(appended.entry.id)).toBe(true);
		}
	});

	it("(l) malformed input is refused before touching the session", async () => {
		const harness = await startConversation();
		const countBefore = harness.sessionManager.getEntries().length;

		const missingText = await sendEdit({ entryId: "x", text: undefined as unknown as string });
		const emptyId = await sendEdit({ entryId: "", text: "hello" });

		expect(missingText.success).toBe(false);
		expect(emptyId.success).toBe(false);
		expect(missingText.errorCode).toBeUndefined();
		expect(harness.sessionManager.getEntries().length).toBe(countBefore);
	});

	it("(k) editing an entry that precedes a compaction abandons the compaction entry", async () => {
		const harness = await startConversation();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		if (!a1) throw new Error("expected an assistant entry");
		const compactionId = harness.sessionManager.appendCompaction("compacted", a1.id, 1000);
		expect(harness.sessionManager.getLeafId()).toBe(compactionId);

		const line = await sendEdit({ entryId: a1.id, text: "The answer is 42." });

		expect(line.success).toBe(true);
		if (line.data?.outcome !== "edited") throw new Error("expected edited");
		const activeIds = new Set(harness.sessionManager.getBranch(line.data.entry.id).map((e) => e.id));
		expect(activeIds.has(compactionId)).toBe(false);
		expect(harness.sessionManager.getEntry(compactionId)).toBeDefined();
	});
});

describe("RpcClient.editAssistantMessage", () => {
	type RpcClientPrivate = { send: (command: unknown) => Promise<unknown> };

	it("sends the command with the caller's token verbatim and decodes the edited outcome", async () => {
		const client = new RpcClient();
		const send = vi.fn(async () => ({
			type: "response",
			command: "edit_assistant_message",
			success: true,
			data: { outcome: "edited", entry: { id: "new", parentId: "u1", type: "message" }, leafId: "new" },
		}));
		(client as unknown as RpcClientPrivate).send = send;

		const result = await client.editAssistantMessage("a1", "edited", { expectedLeafId: "leaf-0", summarize: false });

		expect(send).toHaveBeenCalledWith({
			type: "edit_assistant_message",
			entryId: "a1",
			text: "edited",
			expectedLeafId: "leaf-0",
			summarize: false,
			customInstructions: undefined,
		});
		expect(result.outcome).toBe("edited");
	});

	it("surfaces a typed errorCode on failure", async () => {
		const client = new RpcClient();
		(client as unknown as RpcClientPrivate).send = vi.fn(async () => ({
			type: "response",
			command: "edit_assistant_message",
			success: false,
			error: "Session leaf moved",
			errorCode: "stale_leaf",
		}));

		const failure = await client.editAssistantMessage("a1", "edited", { expectedLeafId: "old" }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(RpcCommandError);
		expect((failure as RpcCommandError).errorCode).toBe("stale_leaf");
	});
});
