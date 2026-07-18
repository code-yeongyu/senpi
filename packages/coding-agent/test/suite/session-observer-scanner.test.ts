import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import sessionObserverExtension, {
	resolveSessionHudRoot,
	scanSessionHudEntries,
} from "../../src/core/extensions/builtin/session-observer/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./harness.ts";
import {
	BASE_TIME,
	createTempRootRegistry,
	sessionLine,
	testTheme,
	userLine,
	writeSessionFile,
} from "./history-search-fixtures.ts";

const tempRoots = createTempRootRegistry();
const harnesses: Harness[] = [];

interface RecordingUi {
	readonly ui: ExtensionUIContext;
	readonly notifications: readonly string[];
	getCustomCallCount(): number;
}

function createRecordingUi(): RecordingUi {
	const notifications: string[] = [];
	let customCallCount = 0;
	return {
		notifications,
		getCustomCallCount: () => customCallCount,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message) => {
				notifications.push(message);
			},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async <T>() => {
				customCallCount += 1;
				return undefined as T;
			},
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: testTheme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "not implemented" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		},
	};
}

function createRuntime(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("test runtime replacement is not expected");
		},
	);
}

async function submitToInteractiveMode(mode: InteractiveMode, text: string): Promise<void> {
	const setup = Reflect.get(mode, "setupEditorSubmitHandler");
	if (typeof setup !== "function") throw new Error("InteractiveMode setup handler missing");
	setup.call(mode);
	const editor: unknown = Reflect.get(mode, "defaultEditor");
	if (!editor || typeof editor !== "object") throw new Error("InteractiveMode editor missing");
	const submit = Reflect.get(editor, "onSubmit");
	if (typeof submit !== "function") throw new Error("InteractiveMode submit handler missing");
	await submit(text);
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await tempRoots.cleanup();
});

describe("resolveSessionHudRoot", () => {
	const defaultRoot = "/home/user/.senpi/agent/sessions";

	it("returns the cross-cwd sessions root for default session subdirectories", () => {
		expect(resolveSessionHudRoot("", defaultRoot)).toBe(defaultRoot);
		expect(resolveSessionHudRoot(defaultRoot, defaultRoot)).toBe(defaultRoot);
		expect(resolveSessionHudRoot(`${defaultRoot}/encoded-cwd`, defaultRoot)).toBe(defaultRoot);
	});

	it("keeps custom session directories isolated", () => {
		expect(resolveSessionHudRoot("/tmp/custom-sessions", defaultRoot)).toBe("/tmp/custom-sessions");
	});
});

describe("scanSessionHudEntries", () => {
	it("returns empty results for a missing sessions root", async () => {
		const root = await tempRoots.make();

		expect(await scanSessionHudEntries(join(root, "missing"))).toEqual([]);
	});

	it("discovers flat and cwd-nested sessions sorted by newest message", async () => {
		const root = await tempRoots.make();
		const sessionsDir = join(root, "sessions");
		await writeSessionFile(sessionsDir, "20260520_old-session.jsonl", [
			sessionLine("old-session", "/repo-old", BASE_TIME),
			userLine(["old prompt"], BASE_TIME + 1_000),
		]);
		const currentFile = await writeSessionFile(sessionsDir, "20260520_new-session-abcdef.jsonl", [
			sessionLine("new-session-abcdef", "/repo-new", BASE_TIME + 2_000),
			userLine(["new first"], BASE_TIME + 3_000),
			userLine(["new last"], BASE_TIME + 4_000),
		]);
		await mkdir(sessionsDir, { recursive: true });
		await writeFile(
			join(sessionsDir, "20260520_flat-session.jsonl"),
			[
				sessionLine("flat-session", "/repo-flat", BASE_TIME + 1_000),
				userLine(["flat prompt"], BASE_TIME + 2_500),
			].join("\n"),
			"utf-8",
		);

		const sessions = await scanSessionHudEntries(sessionsDir, currentFile);

		expect(sessions.map((session) => session.id)).toEqual(["new-session-abcdef", "flat-session", "old-session"]);
		expect(sessions[0]).toMatchObject({
			shortId: "new-sess",
			cwd: "/repo-new",
			messageCount: 2,
			lastUserText: "new last",
			isCurrent: true,
		});
		expect(sessions[1]?.lastUserText).toBe("flat prompt");
		expect(sessions[2]?.isCurrent).toBe(false);
	});

	it("ignores malformed session entries without disabling picker", async () => {
		const root = await tempRoots.make();
		const sessionsDir = join(root, "sessions");
		await writeSessionFile(sessionsDir, "20260520_valid-session.jsonl", [
			sessionLine("valid-session", "/repo-valid", BASE_TIME),
			userLine(["valid prompt"], BASE_TIME + 1_000),
		]);
		await writeFile(join(sessionsDir, "20260520_broken-session.jsonl"), "{not json", "utf-8");

		const sessions = await scanSessionHudEntries(sessionsDir);

		expect(sessions.map((session) => session.id)).toEqual(["valid-session"]);
	});
});

describe("sessionObserverExtension", () => {
	it("registers /sessions and no-ops safely without interactive UI", async () => {
		const harness = await createHarness({ extensionFactories: [sessionObserverExtension] });
		harnesses.push(harness);

		const command = harness.session.extensionRunner.getRegisteredCommands().find((item) => item.name === "sessions");
		expect(command?.invocationName).toBe("sessions");

		await harness.session.prompt("/sessions");
		expect(harness.session.messages).toEqual([]);
	});

	it("opens session picker when sessions exist", async () => {
		const root = await tempRoots.make();
		const sessionsDir = join(root, "sessions");
		await writeSessionFile(sessionsDir, "20260520_valid-session.jsonl", [
			sessionLine("valid-session", "/repo-valid", BASE_TIME),
			userLine(["valid prompt"], BASE_TIME + 1_000),
		]);
		const previousDir = process.env.SENPI_CODING_AGENT_DIR;
		process.env.SENPI_CODING_AGENT_DIR = root;
		try {
			const harness = await createHarness({ extensionFactories: [sessionObserverExtension] });
			harnesses.push(harness);
			const recording = createRecordingUi();
			harness.session.extensionRunner.setUIContext(recording.ui);
			const mode = new InteractiveMode(createRuntime(harness), { verbose: false });

			await submitToInteractiveMode(mode, "/sessions");

			expect(recording.getCustomCallCount()).toBe(1);
			expect(recording.notifications).toEqual([]);
		} finally {
			if (previousDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
			else process.env.SENPI_CODING_AGENT_DIR = previousDir;
		}
	});

	it("shows empty state when no sessions exist", async () => {
		const root = await tempRoots.make();
		const previousDir = process.env.SENPI_CODING_AGENT_DIR;
		process.env.SENPI_CODING_AGENT_DIR = root;
		try {
			const harness = await createHarness({ extensionFactories: [sessionObserverExtension] });
			harnesses.push(harness);
			const recording = createRecordingUi();
			harness.session.extensionRunner.setUIContext(recording.ui);
			const mode = new InteractiveMode(createRuntime(harness), { verbose: false });

			await submitToInteractiveMode(mode, "/sessions");

			expect(recording.notifications).toEqual(["No sessions found"]);
			expect(recording.getCustomCallCount()).toBe(0);
		} finally {
			if (previousDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
			else process.env.SENPI_CODING_AGENT_DIR = previousDir;
		}
	});

	it("keeps adjacent slash command dispatch behavior", async () => {
		const harness = await createHarness({ extensionFactories: [sessionObserverExtension] });
		harnesses.push(harness);
		const mode = new InteractiveMode(createRuntime(harness), { verbose: false });
		const submittedInputs: string[] = [];
		Reflect.set(mode, "onInputCallback", (text: string) => {
			submittedInputs.push(text);
		});

		await submitToInteractiveMode(mode, "/unknown-command");

		expect(submittedInputs).toEqual(["/unknown-command"]);
	});
});
