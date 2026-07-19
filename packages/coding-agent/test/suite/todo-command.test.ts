import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findPhaseFuzzy,
	findTaskFuzzy,
	registerTodoCommand,
	tokenizeTodoArgs,
} from "../../src/core/extensions/builtin/todotools/commands.ts";
import {
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "../../src/core/extensions/builtin/todotools/markdown.ts";
import {
	clonePhases,
	TODO_STATE_ENTRY_TYPE,
	type TodoPhase,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../src/core/extensions/types.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function samplePhases(): TodoPhase[] {
	return [
		{
			name: "Foundation",
			tasks: [
				{ content: "Scaffold workspace", status: "completed" },
				{ content: "Wire entrypoint", status: "in_progress" },
			],
		},
		{ name: "Verification", tasks: [{ content: "Run focused tests", status: "pending" }] },
	];
}

function createCommandFixture(initialPhases: TodoPhase[] = [], options: { editorText?: string; cwd?: string } = {}) {
	let phases = clonePhases(initialPhases);
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const sentMessages: Array<{ customType: string; content: string }> = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const commands = new Map<string, CommandHandler>();

	const api = {
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		appendEntry(customType: string, data?: unknown) {
			appendedEntries.push({ customType, data });
		},
		sendMessage(message: { customType: string; content: string }) {
			sentMessages.push({ customType: message.customType, content: message.content });
		},
	} as unknown as ExtensionAPI;

	registerTodoCommand(api, {
		getCurrentPhases: () => clonePhases(phases),
		setCurrentPhases: (next) => {
			phases = clonePhases(next);
		},
		syncWidget: () => {},
	});

	const ctx = {
		cwd: options.cwd ?? "/tmp",
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			editor: vi.fn(async () => options.editorText),
		},
	} as unknown as ExtensionCommandContext;

	const handler = commands.get("todo");
	if (!handler) throw new Error("Expected /todo command to be registered");

	return {
		run: (args: string) => handler(args, ctx),
		getPhases: () => clonePhases(phases),
		appendedEntries,
		sentMessages,
		notifications,
		ctx,
	};
}

describe("todo markdown round-trip", () => {
	it("renders phases as a checklist and parses it back verbatim", () => {
		const phases: TodoPhase[] = [
			{
				name: "Foundation",
				tasks: [
					{ content: "Done work", status: "completed" },
					{ content: "Active work", status: "in_progress" },
					{ content: "Dropped work", status: "abandoned" },
				],
			},
			{ name: "Verification", tasks: [{ content: "Open work", status: "pending" }] },
		];

		const markdown = phasesToMarkdown(phases);
		expect(markdown).toBe(
			[
				"# Foundation",
				"- [x] Done work",
				"- [/] Active work",
				"- [-] Dropped work",
				"",
				"# Verification",
				"- [ ] Open work",
				"",
			].join("\n"),
		);

		const parsed = markdownToPhases(markdown);
		expect(parsed.errors).toEqual([]);
		expect(parsed.phases).toEqual(phases);
	});

	it("reports unknown markers and unrecognized lines with line numbers", () => {
		const { errors } = markdownToPhases("# Phase\n- [?] Mystery\nplain prose\n");
		expect(errors).toEqual([
			'Line 2: unknown status marker "[?]" (use [ ], [x], [/], [-])',
			'Line 3: unrecognized syntax "plain prose"',
		]);
	});

	it("synthesizes a Todos phase for headerless checklists and normalizes in_progress", () => {
		const { phases, errors } = markdownToPhases("- [/] First\n- [/] Second\n");
		expect(errors).toEqual([]);
		expect(phases).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "First", status: "in_progress" },
					{ content: "Second", status: "pending" },
				],
			},
		]);
	});

	it("resolves export/import paths against cwd with a TODO.md default", () => {
		expect(resolveTodoMarkdownPath("", "/work")).toBe("/work/TODO.md");
		expect(resolveTodoMarkdownPath("notes/plan.md", "/work")).toBe("/work/notes/plan.md");
		expect(resolveTodoMarkdownPath('"/abs/plan.md"', "/work")).toBe("/abs/plan.md");
	});
});

describe("todo command helpers", () => {
	it("tokenizes quoted arguments and escapes", () => {
		expect(tokenizeTodoArgs('Auth "Wire the flow" done\\ deal')).toEqual(["Auth", "Wire the flow", "done deal"]);
	});

	it("fuzzy-matches phases by exact name, unique prefix, and unique substring", () => {
		const phases = samplePhases();
		expect(findPhaseFuzzy(phases, "foundation")?.name).toBe("Foundation");
		expect(findPhaseFuzzy(phases, "verif")?.name).toBe("Verification");
		expect(findPhaseFuzzy(phases, "missing")).toBeUndefined();
	});

	it("fuzzy-matches tasks and prefers open work on ambiguity", () => {
		const phases: TodoPhase[] = [
			{
				name: "Tasks",
				tasks: [
					{ content: "Ship feature", status: "completed" },
					{ content: "Ship feature docs", status: "pending" },
				],
			},
		];
		expect(findTaskFuzzy(phases, "ship feature")?.task.content).toBe("Ship feature");
		expect(findTaskFuzzy(phases, "ship")?.task.content).toBe("Ship feature docs");
	});
});

describe("/todo command", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("appends a task, persists a user-sourced v2 entry, and notifies the agent", async () => {
		const fixture = createCommandFixture(samplePhases());

		await fixture.run("append Verification Audit the logs");

		expect(fixture.getPhases()[1].tasks.map((task) => task.content)).toEqual(["Run focused tests", "Audit the logs"]);
		const entry = fixture.appendedEntries.at(-1);
		expect(entry?.customType).toBe(TODO_STATE_ENTRY_TYPE);
		expect(entry?.data).toMatchObject({ schema: "v2", source: "user" });
		expect(fixture.sentMessages.at(-1)?.customType).toBe("todotools.user-edit");
		expect(fixture.sentMessages.at(-1)?.content).toContain("The user manually modified the todo list");
	});

	it("marks a fuzzy-matched task done and auto-promotes the earliest open task", async () => {
		const fixture = createCommandFixture(samplePhases());

		await fixture.run("done wire entry");

		const phases = fixture.getPhases();
		expect(phases[0].tasks[1]).toEqual({ content: "Wire entrypoint", status: "completed" });
		expect(phases[1].tasks[0].status).toBe("in_progress");
	});

	it("rm without arguments clears the list and flags the removal intent", async () => {
		const fixture = createCommandFixture(samplePhases());

		await fixture.run("rm");

		expect(fixture.getPhases()).toEqual([]);
		expect(fixture.sentMessages.at(-1)?.content).toContain("intentionally cleared");
	});

	it("exports and imports a Markdown checklist round-trip through disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "todo-cmd-"));
		tempDirs.push(dir);
		const target = join(dir, "TODO.md");
		const fixture = createCommandFixture(samplePhases(), { cwd: dir });

		await fixture.run("export");
		expect(readFileSync(target, "utf8")).toBe(phasesToMarkdown(samplePhases()));

		writeFileSync(target, "# Replacement\n- [ ] Fresh task\n");
		await fixture.run("import");
		expect(fixture.getPhases()).toEqual([
			{ name: "Replacement", tasks: [{ content: "Fresh task", status: "in_progress" }] },
		]);
	});

	it("edit applies overlay-editor markdown and rejects unparseable edits", async () => {
		const good = createCommandFixture(samplePhases(), {
			editorText: "# Only Phase\n- [x] Everything shipped\n",
		});
		await good.run("edit");
		expect(good.getPhases()).toEqual([
			{ name: "Only Phase", tasks: [{ content: "Everything shipped", status: "completed" }] },
		]);

		const bad = createCommandFixture(samplePhases(), { editorText: "# Phase\n- [?] broken\n" });
		const before = bad.getPhases();
		await bad.run("edit");
		expect(bad.getPhases()).toEqual(before);
		expect(bad.notifications.at(-1)?.type).toBe("error");
	});

	it("rejects unknown verbs with usage help", async () => {
		const fixture = createCommandFixture();
		await fixture.run("frobnicate");
		expect(fixture.notifications.at(-1)?.type).toBe("error");
		expect(fixture.notifications.at(-1)?.message).toContain("Usage: /todo");
	});
});
