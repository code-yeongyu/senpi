import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import {
	buildTodoOwedReminder,
	firstTodoOwedSuppression,
	TODO_OWED_CUSTOM_TYPE,
	TODO_OWED_REMINDER_EVENT,
	type TodoOwedInput,
	type TodoOwedReminderEvent,
} from "../../src/core/extensions/builtin/goal/todo-owed-backstop.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionMode } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of predicateTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Notice = { message: string; type: string | undefined };

type BackstopHarness = {
	harness: Harness;
	notices: Notice[];
	events: TodoOwedReminderEvent[];
};

const ANCHORS = { ask: "build the parser", now: "Write the parser (Build)", next: "Wire the parser (Build)" };

const askUserTool: AgentTool = {
	name: "ask_user_question",
	label: "Ask user",
	description: "Test stand-in for the ask-user tool",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "question queued" }], details: {} }),
};

async function createBackstopHarness(
	options: { mode?: ExtensionMode; turnEndBackstop?: boolean } = {},
): Promise<BackstopHarness> {
	const events: TodoOwedReminderEvent[] = [];
	const probe = (pi: ExtensionAPI): void => {
		pi.events.on(TODO_OWED_REMINDER_EVENT, (data) => events.push(data as TodoOwedReminderEvent));
	};
	const harness = await createHarness({
		extensionFactories: [todotoolsExtension, goalExtension, probe],
		tools: [askUserTool],
		fileSettings: true,
		settings: {
			todo: {
				firstTurnPlan: "off",
				...(options.turnEndBackstop === undefined ? {} : { turnEndBackstop: options.turnEndBackstop }),
			},
		},
	});
	harnesses.push(harness);
	const notices: Notice[] = [];
	const runner = harness.getExtensionRunner();
	runner.setUIContext(
		{ ...runner.getUIContext(), notify: (message, type) => notices.push({ message, type }) },
		options.mode ?? "tui",
	);
	return { harness, notices, events };
}

const OPEN_TODO = fauxToolCall("todo", {
	op: "init",
	list: [{ phase: "Build", items: ["Write the parser", "Wire the parser"] }],
});

const OPEN_PHASES = [{ name: "Build", tasks: [{ content: "Write the parser", status: "in_progress" }] }];

function todoToolResultEntry(): SessionEntry {
	return {
		type: "message",
		id: "todo-entry",
		parentId: null,
		timestamp: "2026-09-25T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolName: "todo",
			toolCallId: "call-1",
			content: [{ type: "text", text: "registered" }],
			details: { op: "init", phases: OPEN_PHASES, storage: "memory" },
		},
	} as unknown as SessionEntry;
}

const predicateTempDirs: string[] = [];

function predicateCtxBase(): ExtensionContext {
	const tempDir = predicateTempDirs.at(-1) ?? mkdtempSync(join(tmpdir(), "todo-owed-backstop-"));
	if (predicateTempDirs.length === 0) predicateTempDirs.push(tempDir);
	return {
		cwd: tempDir,
		agentDir: tempDir,
		isProjectTrusted: () => false,
		mode: "tui",
		sessionManager: {
			getHeader: () => null,
			getSessionId: () => "session-1",
			getBranch: () => [todoToolResultEntry()],
		},
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
}

function predicateInput(overrides: Partial<TodoOwedInput> = {}): TodoOwedInput {
	return {
		ctx: predicateCtxBase(),
		event: { type: "agent_end", messages: [fauxAssistantMessage("Parser plan is ready.")] },
		goal: null,
		continuationPending: false,
		hasActiveWakeSources: false,
		...overrides,
	};
}

function openTodoThen(...finals: FauxResponseStep[]): FauxResponseStep[] {
	return [fauxAssistantMessage([OPEN_TODO], { stopReason: "toolUse" }), ...finals];
}

function owedContents(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === TODO_OWED_CUSTOM_TYPE && entry.display === false
				? [typeof entry.content === "string" ? entry.content : ""]
				: [],
		);
}

describe("firstTodoOwedSuppression", () => {
	it("reports no suppression for an owed main-session turn without a goal", () => {
		// given / when
		const suppression = firstTodoOwedSuppression(predicateInput());

		// then
		expect(suppression).toBeUndefined();
	});

	it("suppresses while a goal owns the turn end, even with no continuation pending", () => {
		// given
		const input = predicateInput({ goal: goalFixture("active") });

		// when
		const suppression = firstTodoOwedSuppression(input);

		// then
		expect(suppression).toBe("active-goal");
	});

	it.each(["subagent", "non-interactive", "pending-messages", "continuation-pending"] as const)(
		"suppresses on the %s clause",
		(clause) => {
			// given
			const input = predicateInput(
				clause === "subagent"
					? { ctx: withHeader("parent-1") }
					: clause === "non-interactive"
						? { ctx: withMode("print") }
						: clause === "pending-messages"
							? { ctx: withPendingMessages() }
							: { continuationPending: true },
			);

			// when
			const suppression = firstTodoOwedSuppression(input);

			// then
			expect(suppression).toBe(clause);
		},
	);
});

describe("todo-owed backstop through the real AgentSession", () => {
	it("queues one hidden followUp that runs a second turn after a text-only end with open todos", async () => {
		// given
		const { harness, events } = await createBackstopHarness();
		harness.setResponses(
			openTodoThen(
				fauxAssistantMessage("Parser plan is ready."),
				fauxAssistantMessage(
					[
						fauxToolCall("todo", { op: "done", task: "Write the parser" }),
						fauxToolCall("todo", { op: "done", task: "Wire the parser" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Parser is written and wired."),
			),
		);

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([buildTodoOwedReminder(ANCHORS, false)]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(events).toEqual([
			{
				sessionId: harness.sessionManager.getSessionId(),
				chainCount: 1,
				openTasks: 2,
				...pick(ANCHORS),
				reason: "delivered",
			},
		]);
	}, 20_000);

	it("stays silent when every todo is closed", async () => {
		// given
		const { harness } = await createBackstopHarness();
		harness.setResponses(
			openTodoThen(
				fauxAssistantMessage(
					[
						fauxToolCall("todo", { op: "done", task: "Write the parser" }),
						fauxToolCall("todo", { op: "drop", task: "Wire the parser" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Parser is written."),
			),
		);

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(3);
	}, 20_000);

	it("stays silent when the final paragraph asks the user a question", async () => {
		// given
		const { harness } = await createBackstopHarness();
		harness.setResponses(
			openTodoThen(
				fauxAssistantMessage("The plan is set.\n\nShould the parser accept trailing commas? Tell me first."),
			),
		);

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
	}, 20_000);

	it("stays silent when the run called the ask-user tool", async () => {
		// given
		const { harness } = await createBackstopHarness();
		harness.setResponses(
			openTodoThen(
				fauxAssistantMessage([fauxToolCall("ask_user_question", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("Waiting on your answer."),
			),
		);

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(3);
	}, 20_000);

	it("stays silent while a goal is active, leaving the turn end to the goal path", async () => {
		// given
		const { harness, events } = await createBackstopHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Ship the parser" }), OPEN_TODO], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Parser plan is ready."),
		]);

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([]);
		expect(events).toEqual([]);
	}, 20_000);

	it("prefixes the second reminder, then notifies once instead of a third", async () => {
		// given
		const { harness, notices, events } = await createBackstopHarness();
		harness.setResponses(
			openTodoThen(
				fauxAssistantMessage("Parser plan is ready."),
				fauxAssistantMessage("Still planning the parser."),
				fauxAssistantMessage("Plan unchanged."),
			),
		);

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([
			buildTodoOwedReminder(ANCHORS, false),
			buildTodoOwedReminder(ANCHORS, true),
		]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(notices.map((notice) => notice.type)).toEqual(["warning"]);
		expect(events.map((event) => [event.reason, event.chainCount, event.openTasks, event.now])).toEqual([
			["delivered", 1, 2, "Write the parser (Build)"],
			["delivered", 2, 2, "Write the parser (Build)"],
			["capped", 2, 2, "Write the parser (Build)"],
		]);
	}, 20_000);

	it("starts a new chain after a new user message", async () => {
		// given
		const { harness, notices } = await createBackstopHarness();
		harness.setResponses(
			openTodoThen(
				fauxAssistantMessage("Parser plan is ready."),
				fauxAssistantMessage("Still planning the parser."),
				fauxAssistantMessage("Plan unchanged."),
				fauxAssistantMessage("Starting over."),
			),
		);
		await harness.session.prompt("build the parser");

		// when
		await harness.session.prompt("keep going");

		// then
		expect(owedContents(harness)).toEqual([
			buildTodoOwedReminder(ANCHORS, false),
			buildTodoOwedReminder(ANCHORS, true),
			buildTodoOwedReminder(ANCHORS, false),
		]);
		expect(notices).toHaveLength(1);
	}, 20_000);

	it("stays silent when todo.turnEndBackstop is false", async () => {
		// given
		const { harness } = await createBackstopHarness({ turnEndBackstop: false });
		harness.setResponses(openTodoThen(fauxAssistantMessage("Parser plan is ready.")));

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
	}, 20_000);

	it("stays silent after a length stop", async () => {
		// given
		const { harness, events } = await createBackstopHarness();
		harness.setResponses(openTodoThen(fauxAssistantMessage("Parser plan is", { stopReason: "length" })));

		// when
		await harness.session.prompt("build the parser");

		// then
		expect(owedContents(harness)).toEqual([]);
		expect(events).toEqual([]);
	}, 20_000);

	it.each(["print", "json"] as const)(
		"stays silent in %s mode",
		async (mode) => {
			// given
			const { harness } = await createBackstopHarness({ mode });
			harness.setResponses(openTodoThen(fauxAssistantMessage("Parser plan is ready.")));

			// when
			await harness.session.prompt("build the parser");

			// then
			expect(owedContents(harness)).toEqual([]);
			expect(harness.faux.state.callCount).toBe(2);
		},
		20_000,
	);
});

function pick(anchors: typeof ANCHORS): { now: string; next: string } {
	return { now: anchors.now, next: anchors.next };
}

function goalFixture(status: Goal["status"]): Goal {
	return {
		id: "goal-1",
		threadId: "session-1",
		objective: "Ship the parser",
		status,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
	};
}

function withHeader(parentSession: string): ExtensionContext {
	return {
		...predicateCtxBase(),
		sessionManager: { getHeader: () => ({ parentSession }) },
	} as unknown as ExtensionContext;
}

function withMode(mode: ExtensionMode): ExtensionContext {
	return { ...predicateCtxBase(), mode } as unknown as ExtensionContext;
}

function withPendingMessages(): ExtensionContext {
	return { ...predicateCtxBase(), hasPendingMessages: () => true } as unknown as ExtensionContext;
}
