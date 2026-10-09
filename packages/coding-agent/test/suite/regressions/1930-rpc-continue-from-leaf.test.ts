import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { CONTINUE_FROM_LEAF_CUSTOM_TYPE } from "../../../src/core/continue-from-leaf.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
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
	error?: string;
	errorCode?: string;
};

function responses(): ResponseLine[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ResponseLine)
		.filter((line) => line.type === "response" && line.command === "continue_from_leaf");
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

let requestCounter = 0;

async function sendContinue(): Promise<ResponseLine> {
	const id = `continue-${++requestCounter}`;
	rpcIo.lineHandler?.(JSON.stringify({ id, type: "continue_from_leaf" }));
	await vi.waitFor(() => expect(responses().some((line) => line.id === id)).toBe(true));
	const line = responses().find((r) => r.id === id);
	if (!line) throw new Error("response vanished");
	return line;
}

describe("RPC continue_from_leaf (#1930)", () => {
	const harnesses: Harness[] = [];
	const snapshots: ListenerSnapshot[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (snapshots.length > 0) restoreListeners(snapshots.pop() as ListenerSnapshot);
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	async function startRpc(conversation: boolean): Promise<Harness> {
		snapshots.push(takeListenerSnapshot());
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		if (conversation) {
			harness.setResponses([fauxAssistantMessage("The answer is 41.")]);
			await harness.session.prompt("What is the answer?");
		}
		void runRpcMode(createRuntimeHost(harness));
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		return harness;
	}

	it("continues from the leaf over the wire with no new prompt", async () => {
		const harness = await startRpc(true);
		harness.setResponses([fauxAssistantMessage("And that is final.")]);

		const line = await sendContinue();
		await harness.session.agent.waitForIdle();

		expect(line.success).toBe(true);
		const messages = harness.session.agent.state.messages;
		expect(messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"What is the answer?",
		]);
		const last = messages[messages.length - 1];
		expect(last?.role === "assistant" ? getMessageText(last) : undefined).toBe("And that is final.");
		expect(
			messages.filter(
				(message) => message.role === "custom" && message.customType === CONTINUE_FROM_LEAF_CUSTOM_TYPE,
			),
		).toHaveLength(1);
	});

	it("answers a refusal with its typed errorCode and starts nothing", async () => {
		const harness = await startRpc(false);
		const callsBefore = harness.faux.state.callCount;

		const line = await sendContinue();

		expect(line.success).toBe(false);
		expect(line.errorCode).toBe("nothing_to_continue");
		expect(harness.faux.state.callCount).toBe(callsBefore);
	});
});
