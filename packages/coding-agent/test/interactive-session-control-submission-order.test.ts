import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory, SessionControlWakeEvent } from "../src/core/extensions/types.ts";
import { deliveryIdOf } from "../src/core/external-admission.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { TuiSessionControlHost } from "../src/modes/interactive/session-control-host.ts";
import type { TuiControlContext } from "../src/modes/interactive/session-control-lifecycle.ts";
import { controlData } from "./helpers/session-control-client.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

vi.mock("../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

interface InputLike {
	readonly text: string;
	readonly ticket?: { release(): void };
}

/** The InteractiveMode members this test drives for real; everything else is inert. */
interface ModeMethods {
	setupEditorSubmitHandler(this: object): void;
	sessionControlContext(this: object): Omit<TuiControlContext, "editorRevision">;
	getUserInput(this: object): Promise<InputLike>;
	buildMainLoopPromptOptions(this: object, input: InputLike): Record<string, unknown>;
	handleAnswerCommand(this: object, argument: string): Promise<void>;
}

const mode = InteractiveMode.prototype as unknown as ModeMethods;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function inert<T extends object>(known: T): T {
	const created = new Map<PropertyKey, unknown>();
	return new Proxy(known, {
		get(target, property, receiver) {
			if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
			if (!created.has(property))
				created.set(
					property,
					vi.fn(() => undefined),
				);
			return created.get(property);
		},
	});
}

/** A TUI shell around a real AgentSession: the real submit handler, main-loop body and control context. */
async function terminal(harness: Harness, rows: Map<string, string>, overrides: Record<string, unknown> = {}) {
	const known: Record<string, unknown> & { defaultEditor: { onSubmit?: (text: string) => void } } = {
		session: harness.session,
		defaultEditor: {},
		editor: inert({ getText: () => "" }),
		pendingUserInputs: [],
		pendingImages: new Map(),
		pendingQuestions: new Map(),
		askUserQuestion: undefined,
		onInputCallback: undefined,
		lastEditorText: "",
		isExtensionCommand: () => false,
		submitAsyncQuestionComment: () => false,
		takeSubmissionImages: () => [],
		beginUserEcho: () => undefined,
		optimisticUserEchoes: inert({
			promptOptions: () => ({ preflightResult: () => undefined, promptDisposition: () => undefined }),
		}),
		composerHold: () => undefined,
		agentIdle: false,
		...overrides,
	};
	const shell = inert(known);
	const control = new TuiSessionControlHost(() => mode.sessionControlContext.call(shell));
	known.sessionControlHost = control;
	mode.setupEditorSubmitHandler.call(shell);
	control.attachEditor(known.defaultEditor, () => false);
	const admitted: string[] = [];
	const inboxDir = join(harness.tempDir, "inbox");
	mkdirSync(inboxDir, { recursive: true });
	const registration = await control.register({
		inboxDir,
		drain: (event: SessionControlWakeEvent) => {
			for (const [id, text] of rows) {
				const result = harness.session.externalAdmission.admit({ delivery_id: id, text, deliverAs: "followUp" });
				admitted.push(`${id}:${result.kind}:${event.reason}`);
				if (result.kind !== "held_draft") rows.delete(id);
			}
			return undefined;
		},
	});
	if (registration.status !== "registered") throw new Error(`registration ${JSON.stringify(registration)}`);
	cleanups.push(() => control.disposeActive());
	const submit = (text: string) => known.defaultEditor.onSubmit?.(text);
	// The body of InteractiveMode.run()'s main loop, with the real prompt options it builds.
	const loop = async (count: number) => {
		for (let taken = 0; taken < count; taken++) {
			const input = await mode.getUserInput.call(shell);
			try {
				await harness.session.prompt(input.text, mode.buildMainLoopPromptOptions.call(shell, input));
			} finally {
				input.ticket?.release();
			}
		}
	};
	return { control, socket: registration.socket, submit, loop, admitted };
}

function transcript(harness: Harness): string[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type === "message" && entry.message.role === "user") {
			const content = entry.message.content;
			return [
				`user:${typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join("")}`,
			];
		}
		if (entry.type === "custom_message") {
			const id = deliveryIdOf({ role: "custom", ...entry, timestamp: 0 });
			return id === undefined ? [] : [`delivery:${id}`];
		}
		return [];
	});
}

async function harnessWithInputGate() {
	const firstEntered = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const gate: ExtensionFactory = (pi) => {
		pi.on("input", async (event) => {
			if (event.text === "first") {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			return { action: "continue" };
		});
	};
	const harness = await createHarness({ persistSession: true, extensionFactories: [gate] });
	cleanups.push(() => harness.cleanup());
	harness.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2"), fauxAssistantMessage("r3")]);
	await harness.session.bindExtensions({});
	return { harness, firstEntered: firstEntered.promise, releaseFirst: () => releaseFirst.resolve() };
}

describe("session control admission never overtakes submitted input", () => {
	it("a delivery waits behind BOTH buffered submissions: first, second, then the delivery", async () => {
		const { harness, firstEntered, releaseFirst } = await harnessWithInputGate();
		const rows = new Map<string, string>();
		const tui = await terminal(harness, rows);
		const emitted = new Promise<void>((resolve) => harness.session.externalAdmission.onEmitted(() => resolve()));

		const loop = tui.loop(2);
		tui.submit("first");
		await firstEntered;
		tui.submit("second");
		rows.set("d1", "remote-d1");
		expect(await controlData(tui.socket, { type: "wake" })).toEqual({ admitted: [] });
		expect(await controlData(tui.socket, { type: "get_state" })).toMatchObject({ editor_has_draft: true });

		releaseFirst();
		await loop;
		await emitted;
		await harness.session.waitForIdle();
		expect(transcript(harness)).toEqual(["user:first", "user:second", "delivery:d1"]);
		expect(tui.admitted.at(-1)).toMatch(/^d1:(started|queued):submission$/);
		expect(tui.admitted.slice(0, -1).every((entry) => entry.startsWith("d1:held_draft:"))).toBe(true);
	});

	it("a delivery arriving while a `!` command runs is started: the command does not hold admission", async () => {
		const harness = await createHarness({ persistSession: true });
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("r1")]);
		await harness.session.bindExtensions({});
		const rows = new Map<string, string>();
		const bash = Promise.withResolvers<void>();
		const tui = await terminal(harness, rows, { handleBashCommand: () => bash.promise });

		tui.submit("!sleep 12");
		expect(tui.control.submissionInFlight()).toBe(false);
		rows.set("d1", "remote-d1");
		await controlData(tui.socket, { type: "wake" });
		expect(tui.admitted).toHaveLength(1);
		expect(tui.admitted[0]).toMatch(/^d1:started:/);
		expect(await controlData(tui.socket, { type: "get_state" })).toMatchObject({ editor_has_draft: false });

		bash.resolve();
		await harness.session.waitForIdle();
		expect(transcript(harness)).toEqual(["delivery:d1"]);
	});

	it("a turn an extension starts during the first input's preflight does not release the hold", async () => {
		const { harness, firstEntered, releaseFirst } = await harnessWithInputGate();
		const tui = await terminal(harness, new Map());
		const loop = tui.loop(1);
		tui.submit("first");
		await firstEntered;
		await harness.session.sendCustomMessage(
			{ customType: "ext-note", content: "extension turn", display: false, details: undefined },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();
		expect(tui.control.submissionInFlight()).toBe(true);
		expect(harness.session.externalAdmission.gate()).toMatchObject({ can_admit: false, hold_reason: "draft" });
		releaseFirst();
		await loop;
		expect(tui.control.submissionInFlight()).toBe(false);
	});
});

async function harnessWithCommands() {
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const commands: ExtensionFactory = (pi) => {
		pi.registerCommand("ask", {
			description: "submits text after an await",
			handler: async (args) => {
				entered.resolve();
				await release.promise;
				pi.sendUserMessage(`asked: ${args}`, { deliverAs: "followUp" });
			},
		});
		pi.registerCommand("noop", {
			description: "never submits",
			handler: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		pi.registerCommand("boom", {
			description: "throws after an await",
			handler: async () => {
				entered.resolve();
				await release.promise;
				throw new Error("boom");
			},
		});
	};
	const harness = await createHarness({ persistSession: true, extensionFactories: [commands] });
	cleanups.push(() => harness.cleanup());
	harness.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2"), fauxAssistantMessage("r3")]);
	await harness.session.bindExtensions({});
	const isExtensionCommand = (text: string) =>
		text.startsWith("/") &&
		harness.session.extensionRunner.getCommand(text.slice(1).split(" ")[0] ?? "") !== undefined;
	return { harness, isExtensionCommand, entered: entered.promise, release: () => release.resolve() };
}

describe("commands that may submit text after an await hold admission until they did", () => {
	it("draft held, Enter on /ask, the command sends after an await: the delivery lands after its text", async () => {
		const { harness, isExtensionCommand, entered, release } = await harnessWithCommands();
		const rows = new Map<string, string>();
		let draft: "draft" | undefined = "draft";
		const tui = await terminal(harness, rows, { isExtensionCommand, composerHold: () => draft });
		rows.set("d1", "remote-d1");
		await controlData(tui.socket, { type: "wake" });
		draft = undefined;
		tui.submit("/ask why");
		await entered;
		await controlData(tui.socket, { type: "wake" });
		const emitted = new Promise<void>((resolve) => harness.session.externalAdmission.onEmitted(() => resolve()));
		release();
		await emitted;
		await harness.session.waitForIdle();
		expect(transcript(harness)).toEqual(["user:asked: why", "delivery:d1"]);
		expect(tui.admitted.slice(0, -1).every((entry) => entry.startsWith("d1:held_draft:"))).toBe(true);
		expect(tui.admitted.length).toBeGreaterThanOrEqual(3);
	});

	it.each(["/noop", "/boom"])(
		"a command that never submits (%s) releases the hold when its handler settles",
		async (command) => {
			const { harness, isExtensionCommand, entered, release } = await harnessWithCommands();
			const rows = new Map<string, string>();
			const tui = await terminal(harness, rows, { isExtensionCommand });
			tui.submit(command);
			await entered;
			rows.set("d1", "remote-d1");
			await controlData(tui.socket, { type: "wake" });
			expect(tui.admitted.length).toBeGreaterThan(0);
			expect(tui.admitted.every((entry) => entry.startsWith("d1:held_draft:"))).toBe(true);
			const emitted = new Promise<void>((resolve) => harness.session.externalAdmission.onEmitted(() => resolve()));
			release();
			await emitted;
			await harness.session.waitForIdle();
			expect(transcript(harness)).toEqual(["delivery:d1"]);
			expect(tui.admitted.at(-1)).toMatch(/^d1:started:/);
		},
	);

	it("/answer skip holds until its dismissal message was accepted, then the delivery lands after it", async () => {
		const harness = await createHarness({ persistSession: true });
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2")]);
		await harness.session.bindExtensions({});
		const completion = Promise.withResolvers<void>();
		const question = {
			request: {
				requestId: "q-1",
				questions: [
					{ id: "q1", header: "Pick", question: "Which?", options: [{ label: "a" }], multiSelect: false },
				],
				waitForAnswer: false,
				timeoutMs: 60_000,
			},
			draft: { answers: {} },
			finish: () => undefined,
			completion: completion.promise,
		};
		const rows = new Map<string, string>();
		const tui = await terminal(harness, rows, {
			shownQuestion: question,
			handleAnswerCommand: mode.handleAnswerCommand,
		});
		tui.submit("/answer skip");
		rows.set("d1", "remote-d1");
		await controlData(tui.socket, { type: "wake" });
		expect(tui.admitted.length).toBeGreaterThan(0);
		expect(tui.admitted.every((entry) => entry.startsWith("d1:held_draft:"))).toBe(true);
		const emitted = new Promise<void>((resolve) => harness.session.externalAdmission.onEmitted(() => resolve()));
		completion.resolve();
		await emitted;
		await harness.session.waitForIdle();
		const order = transcript(harness);
		expect(order).toHaveLength(2);
		expect(order[0]).toMatch(/^user:/);
		expect(order[1]).toBe("delivery:d1");
	});
});

describe("manual continue", () => {
	it("releases the hold once its turn starts: a mid-turn follow-up is queued and the editor reads empty", async () => {
		const harness = await createHarness({ persistSession: true });
		cleanups.push(() => harness.cleanup());
		const gate = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			async () => {
				await gate.promise;
				return fauxAssistantMessage("continued");
			},
			fauxAssistantMessage("after the follow-up"),
		]);
		await harness.session.bindExtensions({});
		const tui = await terminal(harness, new Map());
		const firstTurn = tui.loop(1);
		tui.submit("hello");
		await firstTurn;
		await harness.session.waitForIdle();

		const started = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "agent_start") return;
				unsubscribe();
				resolve();
			});
		});
		const continued = tui.loop(1);
		tui.submit(".");
		await started;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(await controlData(tui.socket, { type: "get_state" })).toMatchObject({ editor_has_draft: false });
		const admission = harness.session.externalAdmission.admit({
			delivery_id: "f1",
			text: "remote follow-up",
			deliverAs: "followUp",
		});
		expect(admission.kind).toBe("queued");

		gate.resolve();
		await continued;
		await harness.session.waitForIdle();
		expect(transcript(harness)).toEqual(["user:hello", "delivery:f1"]);
	});
});
