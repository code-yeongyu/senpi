/**
 * Plan X13 (Z1.a): today's crash recovery on the fused path. A real child process is SIGKILLed while a
 * dispatched tool body runs, or while a finished sibling's result is still held by its unreleased batch;
 * the session is then reopened from disk. Pinned: the dangling calls get the placeholder result, no tool
 * re-runs, and a pending ask_user question is re-asked or settled orphaned-after-restart.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import { ASK_USER_SETTLEMENT_ENTRY } from "../../src/core/extensions/builtin/ask-user/notify.ts";
import type { QuestionResponse } from "../../src/core/extensions/builtin/ask-user/schema.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { TOOL_RESULT_PLACEHOLDER } from "../../src/core/extensions/builtin/compaction/repair-tool-pairs.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	KILL_BARRIER_LINE_PREFIX,
	KILL_BARRIER_SCENARIOS,
	type KillBarrierReport,
	type KillBarrierScenarioName,
	readLedger,
	resumeTools,
} from "../fixtures/kill-barrier/kill-barrier.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const CHILD = join(import.meta.dirname, "../fixtures/kill-barrier/kill-barrier-child.ts");
const BARRIER_TIMEOUT_MS = 20_000;
const roots: string[] = [];
const harnesses: Harness[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

interface KilledRun {
	readonly root: string;
	readonly report: KillBarrierReport;
}

async function killAtBarrier(name: KillBarrierScenarioName): Promise<KilledRun> {
	const root = mkdtempSync(join(tmpdir(), "kill-barrier-"));
	roots.push(root);
	const child = spawn("bun", [CHILD, name, root], {
		env: { ...process.env, TMPDIR: root },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	const exited = new Promise<NodeJS.Signals | null>((resolve) =>
		child.once("exit", (_code, signal) => resolve(signal)),
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const reached = Promise.withResolvers<KillBarrierReport>();
	if (child.stdout === null) throw new Error("kill-barrier child has no stdout pipe");
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (line.startsWith(KILL_BARRIER_LINE_PREFIX))
			reached.resolve(JSON.parse(line.slice(KILL_BARRIER_LINE_PREFIX.length)));
	});
	void exited.then(() => reached.reject(new Error(`child exited before the barrier: ${stderr}`)));
	const timer = setTimeout(
		() => reached.reject(new Error(`no barrier within ${BARRIER_TIMEOUT_MS}ms: ${stderr}`)),
		BARRIER_TIMEOUT_MS,
	);
	try {
		const report = await reached.promise;
		child.kill("SIGKILL");
		expect(await exited).toBe("SIGKILL");
		return { root, report };
	} finally {
		clearTimeout(timer);
	}
}

function persistedToolResultIds(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const entry: { type?: string; message?: { role?: string; toolCallId?: string } } = JSON.parse(line);
			return entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId
				? [entry.message.toolCallId]
				: [];
		});
}

describe("X13: fused crash recovery today", () => {
	it.each(["dispatched-body", "unreleased-siblings"] as const)(
		"%s: the dangling calls get the placeholder result and no tool re-runs on resume",
		async (name) => {
			const scenario = KILL_BARRIER_SCENARIOS[name];
			const callIds = scenario.calls.map((call) => call.id);
			const ledger = (root: string) => join(root, "ledger");

			const { root, report } = await killAtBarrier(name);
			expect(report).toMatchObject({ toolCallId: scenario.barrierId, durable: true });
			expect(readLedger(ledger(root))).toEqual(callIds);
			expect(persistedToolResultIds(report.sessionFile)).toEqual([]);

			const requests: Message[][] = [];
			const harness = await createHarness({
				sessionManager: SessionManager.open(report.sessionFile),
				cwd: root,
				tools: resumeTools(scenario, ledger(root)),
				settings: { compaction: { enabled: false, speculativeEnabled: false, idleCompactionEnabled: false } },
				extensionFactories: [{ name: "compaction", factory: compactionExtension }],
			});
			harnesses.push(harness);
			// The CLI's resume restores the reopened branch the same way (createAgentSession, src/core/sdk.ts).
			harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			await harness.session.bindExtensions({});
			const model = harness.getModel();
			harness.setResponses([
				(context) => {
					requests.push(context.messages);
					return Object.assign(fauxAssistantMessage("resumed"), {
						api: model.api,
						provider: model.provider,
						model: model.id,
					});
				},
			]);
			await harness.session.prompt("continue after the crash");
			await harness.agent.waitForIdle();

			expect(requests).toHaveLength(1);
			const request = requests[0] ?? [];
			const assistantIndex = request.findIndex(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			);
			expect(assistantIndex).toBeGreaterThanOrEqual(0);
			expect(request.slice(assistantIndex + 1, assistantIndex + 1 + callIds.length)).toEqual(
				callIds.map((toolCallId) =>
					expect.objectContaining({
						role: "toolResult",
						toolCallId,
						isError: false,
						content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }],
					}),
				),
			);
			expect(readLedger(ledger(root))).toEqual(callIds);
			expect(persistedToolResultIds(report.sessionFile)).toEqual([]);
		},
	);

	function resumeQuestions(sessionManager: SessionManager, question: (request: unknown) => Promise<QuestionResponse>) {
		const handlers: Array<(event: SessionStartEvent, ctx: ExtensionContext) => unknown> = [];
		const userMessages: string[] = [];
		const pi = {
			events: createEventBus(),
			registerFlag() {},
			registerCommand() {},
			registerTool() {},
			getFlag: () => false,
			getActiveTools: () => [],
			setActiveTools() {},
			on(event: string, handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown) {
				if (event === "session_start") handlers.push(handler);
			},
			appendEntry(customType: string, data?: unknown) {
				sessionManager.appendCustomEntry(customType, data);
			},
			sendUserMessage(content: string | Array<{ type: string; text?: string }>) {
				userMessages.push(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""));
			},
		};
		askUserExtension(pi as unknown as ExtensionAPI);
		const context = {
			sessionManager,
			ui: { question, notify: vi.fn() },
			isIdle: () => true,
			getAskUserSettings: () => ({ enabled: true, timeoutMinutes: 30 }),
			mode: "tui",
			hasUI: true,
		} as unknown as ExtensionContext;
		return {
			userMessages,
			start: async () => {
				for (const handler of handlers) await handler({ type: "session_start", reason: "resume" }, context);
			},
		};
	}

	function settlements(sessionManager: SessionManager): unknown[] {
		return sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === ASK_USER_SETTLEMENT_ENTRY ? [entry.data] : [],
			);
	}

	it("pending-question: a question killed while waiting is re-asked once on resume", async () => {
		const { root, report } = await killAtBarrier("pending-question");
		expect(report).toMatchObject({ toolCallId: "call-question", durable: true });
		const sessionManager = SessionManager.open(report.sessionFile);
		const question = vi.fn((_request: unknown) => new Promise<QuestionResponse>(() => {}));
		const resumed = resumeQuestions(sessionManager, question);

		await resumed.start();

		expect(question).toHaveBeenCalledOnce();
		expect(question.mock.calls[0]?.[0]).toMatchObject({ requestId: "call-question", waitForAnswer: true });
		expect(settlements(sessionManager)).toEqual([]);
		expect(resumed.userMessages).toEqual([]);
		expect(readLedger(join(root, "ledger"))).toEqual(["call-question"]);
	});

	it("unparseable-question: a question whose arguments no longer parse settles orphaned-after-restart", async () => {
		const { root, report } = await killAtBarrier("unparseable-question");
		expect(report).toMatchObject({ toolCallId: "call-question-bad", durable: true });
		const sessionManager = SessionManager.open(report.sessionFile);
		const question = vi.fn(() => new Promise<QuestionResponse>(() => {}));
		const resumed = resumeQuestions(sessionManager, question);

		await resumed.start();

		expect(question).not.toHaveBeenCalled();
		expect(settlements(sessionManager)).toEqual([
			{ requestId: "call-question-bad", status: "orphaned-after-restart" },
		]);
		expect(resumed.userMessages).toHaveLength(1);
		expect(resumed.userMessages[0]?.startsWith("[Answer to question call-question-bad]")).toBe(true);
		expect(readLedger(join(root, "ledger"))).toEqual(["call-question-bad"]);
	});
});
