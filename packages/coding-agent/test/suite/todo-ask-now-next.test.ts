import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTodoSnapshot,
	restoreTodosIfMissing,
	type TodoSnapshotPayload,
} from "../../src/core/extensions/builtin/compaction/todo-bridge.ts";
import { registerTodoCommand } from "../../src/core/extensions/builtin/todotools/commands.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import {
	captureListAsk,
	describeAskNowNext,
	getLatestTodoStateFromBranchEntries,
	TODO_RESTORE_REQUEST_TYPE,
	TODO_STATE_ENTRY_TYPE,
	type TodoAsk,
	type TodoPhase,
	type TodoToolDetails,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import { registerTodoTool } from "../../src/core/extensions/builtin/todotools/tools/todo.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";
import type { CustomEntry, CustomMessageEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createTodoHarness(): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [todotoolsExtension] });
	harnesses.push(harness);
	return harness;
}

async function promptWithTodo(harness: Harness, prompt: string, ...calls: Record<string, unknown>[]): Promise<void> {
	harness.setResponses([
		...calls.map((params) =>
			fauxAssistantMessage([fauxToolCall("todo", params as JsonObject)], { stopReason: "toolUse" }),
		),
		fauxAssistantMessage("ok"),
	]);
	await harness.session.prompt(prompt);
}

async function promptWithText(harness: Harness, prompt: string): Promise<void> {
	harness.setResponses([fauxAssistantMessage("noted")]);
	await harness.session.prompt(prompt);
}

function todoResults(
	harness: Harness,
): Array<{ text: string; details: TodoToolDetails | undefined; isError: boolean }> {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === "todo"
			? [
					{
						text: getMessageText(message),
						details: message.details as TodoToolDetails | undefined,
						isError: message.isError,
					},
				]
			: [],
	);
}

function stateAsks(harness: Harness): Array<string | undefined> {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE
				? [(entry.data as { ask?: TodoAsk }).ask?.text]
				: [],
		);
}

const STAMP = "2026-09-24T00:00:00.000Z";

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: STAMP,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	};
}

function stateEntry(id: string, phases: TodoPhase[], ask?: TodoAsk): CustomEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: STAMP,
		customType: TODO_STATE_ENTRY_TYPE,
		data: { schema: "v2", phases, ...(ask ? { ask } : {}) },
	};
}

const ASK: TodoAsk = { entryId: "u-1", text: "migrate the billing service", capturedAt: 1 };
const PHASES: TodoPhase[] = [{ name: "Build", tasks: [{ content: "Port the ledger", status: "in_progress" }] }];

describe("todo Ask anchor through the real AgentSession", () => {
	it("anchors the first list to the session's first user request", async () => {
		// given
		const harness = await createTodoHarness();
		await promptWithText(harness, "fix the login bug");

		// when
		await promptWithTodo(harness, "go ahead", { op: "init", items: ["Reproduce the bug"] });

		// then
		const [result] = todoResults(harness);
		expect(result?.details?.ask?.text).toBe("fix the login bug");
		expect(result?.text.split("\n")[0]).toBe("Ask: fix the login bug");
	}, 20_000);

	it("re-anchors a mid-task init to the newest user request", async () => {
		// given
		const harness = await createTodoHarness();
		await promptWithTodo(harness, "fix the login bug", { op: "init", items: ["Reproduce the bug"] });

		// when
		await promptWithTodo(harness, "switch to the signup flow", { op: "init", items: ["Audit signup"] });

		// then
		expect(stateAsks(harness)).toEqual(["fix the login bug", "switch to the signup flow"]);
	}, 20_000);

	it("keeps the anchor across start, done, and append", async () => {
		// given
		const harness = await createTodoHarness();
		await promptWithTodo(harness, "fix the login bug", { op: "init", items: ["Reproduce the bug", "Patch it"] });

		// when
		await promptWithTodo(
			harness,
			"keep going",
			{ op: "done", task: "Reproduce the bug" },
			{ op: "append", items: ["Add a regression test"] },
		);

		// then
		expect(stateAsks(harness)).toEqual(["fix the login bug", "fix the login bug", "fix the login bug"]);
		expect(todoResults(harness).map((result) => result.details?.ask?.text)).toEqual([
			"fix the login bug",
			"fix the login bug",
			"fix the login bug",
		]);
	}, 20_000);

	it("skips ask-user answer frames when re-anchoring", async () => {
		// given
		const harness = await createTodoHarness();
		await promptWithTodo(harness, "build the export feature", { op: "init", items: ["Pick a format"] });

		// when
		await promptWithTodo(harness, "[Answer to question q-1]\nCSV", { op: "init", items: ["Write the CSV encoder"] });

		// then
		expect(stateAsks(harness)).toEqual(["build the export feature", "build the export feature"]);
	}, 20_000);

	it("names Now and Next after an out-of-order start", async () => {
		// given
		const harness = await createTodoHarness();
		await promptWithTodo(harness, "ship the release", {
			op: "init",
			list: [
				{ phase: "Prepare", items: ["Bump the version"] },
				{ phase: "Publish", items: ["Tag the commit"] },
			],
		});

		// when
		await promptWithTodo(harness, "tag first", { op: "start", task: "Tag the commit" });

		// then
		const lines = todoResults(harness).at(-1)?.text.split("\n") ?? [];
		expect(lines.slice(0, 4)).toEqual([
			"Ask: ship the release",
			"Now: Tag the commit (Publish)",
			"Next: Bump the version (Prepare)",
			"",
		]);
	}, 20_000);

	it("carries the header on a thrown error result", async () => {
		// given
		const harness = await createTodoHarness();
		await promptWithTodo(harness, "fix the login bug", { op: "init", items: ["Reproduce the bug"] });

		// when
		await promptWithTodo(harness, "close it", { op: "done", task: "Unknown task" });

		// then
		const result = todoResults(harness).at(-1);
		expect(result?.isError).toBe(true);
		expect(result?.text.split("\n").slice(0, 4)).toEqual([
			"Ask: fix the login bug",
			"Now: Reproduce the bug (Tasks)",
			"Next: none",
			"",
		]);
	}, 20_000);

	it("reports no todo list on a view of an empty list", async () => {
		// given
		const harness = await createTodoHarness();

		// when
		await promptWithTodo(harness, "what is on the list", { op: "view" });

		// then
		expect(todoResults(harness)[0]?.text.split("\n").slice(0, 3)).toEqual([
			"Ask: (no user request captured)",
			"Now: none - no todo list",
			"Next: none",
		]);
	}, 20_000);
});

describe("captureListAsk", () => {
	it("truncates the ask to 200 code points and counts the rest", () => {
		// given
		const entries = [userEntry("u-1", "😀".repeat(250))];

		// when
		const ask = captureListAsk(entries, 7);

		// then
		expect(ask).toEqual({ entryId: "u-1", text: `${"😀".repeat(200)}… (+50 chars)`, capturedAt: 7 });
	});

	it("honors the ask a newer compaction restore request carries", () => {
		// given
		const restore: CustomMessageEntry = {
			type: "custom_message",
			id: "restore-1",
			parentId: null,
			timestamp: STAMP,
			customType: TODO_RESTORE_REQUEST_TYPE,
			content: "Restore missing todo tasks from snapshot: []",
			display: false,
			details: { ask: ASK },
		};
		const entries = [userEntry("u-1", "migrate the billing service"), stateEntry("s-1", PHASES, ASK)];

		// when
		const restored = captureListAsk([...entries, userEntry("u-2", "continue"), restore], 9);

		// then
		expect(restored).toEqual(ASK);
	});
});

describe("getLatestTodoStateFromBranchEntries", () => {
	it("returns the phases and the ask of the latest todo state entry", () => {
		// given
		const older: TodoAsk = { entryId: "u-0", text: "older request", capturedAt: 0 };
		const entries = [stateEntry("s-0", [], older), stateEntry("s-1", PHASES, ASK)];

		// when
		const state = getLatestTodoStateFromBranchEntries(entries);

		// then
		expect(state).toEqual({ phases: PHASES, ask: ASK });
	});
});

describe("describeAskNowNext", () => {
	it("reports a fully closed list", () => {
		// given
		const phases: TodoPhase[] = [{ name: "Build", tasks: [{ content: "Port the ledger", status: "completed" }] }];

		// when
		const anchors = describeAskNowNext({ phases, ask: ASK });

		// then
		expect(anchors).toEqual({
			ask: "migrate the billing service",
			now: "none - all tasks closed",
			next: "none",
		});
	});
});

describe("todo compaction snapshot", () => {
	function contextFor(branch: SessionEntry[]): ExtensionContext {
		return {
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		} as unknown as ExtensionContext;
	}

	it("carries the ask into the snapshot and re-emits it on restore", () => {
		// given
		const snapshot = createTodoSnapshot(contextFor([userEntry("u-1", ASK.text), stateEntry("s-1", PHASES, ASK)]));
		const snapshotEntry: CustomEntry = {
			type: "custom",
			id: "snap-1",
			parentId: null,
			timestamp: STAMP,
			customType: "compaction.todo-snapshot",
			data: snapshot,
		};
		const sent: Array<{ customType: string; details?: TodoSnapshotPayload }> = [];
		const pi = {
			sendMessage: (message: { customType: string; details?: TodoSnapshotPayload }) => sent.push(message),
		} as unknown as ExtensionAPI;

		// when
		restoreTodosIfMissing(pi, contextFor([snapshotEntry]));

		// then
		expect(snapshot.ask).toEqual(ASK);
		expect(sent.map((message) => [message.customType, message.details?.ask])).toEqual([
			[TODO_RESTORE_REQUEST_TYPE, ASK],
		]);
	});
});

describe("todo surfaces outside the tool text", () => {
	it("prints the Ask/Now/Next header in the /todo view", async () => {
		// given
		const notices: string[] = [];
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		} as unknown as ExtensionAPI;
		registerTodoCommand(pi, {
			getCurrentPhases: () => PHASES,
			setCurrentPhases: () => {},
			getCurrentAsk: () => ASK,
			syncWidget: () => {},
		});
		const ctx = { ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;

		// when
		await handler?.("", ctx);

		// then
		expect(notices[0]?.split("\n").slice(0, 4)).toEqual([
			"Ask: migrate the billing service",
			"Now: Port the ledger (Build)",
			"Next: none",
			"",
		]);
	});

	it("renders the captured ask above the phases", () => {
		// given
		let tool: ToolDefinition | undefined;
		const pi = {
			registerTool: (definition: ToolDefinition) => {
				tool = definition;
			},
		} as unknown as ExtensionAPI;
		registerTodoTool(pi, {
			getCurrentPhases: () => [],
			setCurrentPhases: () => {},
			getCurrentAsk: () => undefined,
			setCurrentAsk: () => {},
			syncWidget: () => {},
		});
		const theme = { fg: (name: string, text: string) => `<${name}>${text}</${name}>`, bold: (text: string) => text };
		const result = { content: [], details: { op: "view", phases: PHASES, storage: "memory", ask: ASK } };

		// when
		const rendered = tool?.renderResult?.(
			result as never,
			{ expanded: false, isPartial: false },
			theme as never,
			{ args: { op: "view" }, isError: false } as never,
		);

		// then
		expect(rendered?.render(200)[0]?.trimEnd()).toBe("<dim>Ask: migrate the billing service</dim>");
	});
});
