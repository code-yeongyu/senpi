import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ExtensionAPI } from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent(event: AgentSessionEvent): Promise<void> })
	.handleEvent;
const clearStatusIndicator = (
	InteractiveMode.prototype as unknown as { clearStatusIndicator(kind?: "working" | "retry"): void }
).clearStatusIndicator;
const buildMainLoopPromptOptions = (
	InteractiveMode.prototype as unknown as {
		buildMainLoopPromptOptions(userInput: { text: string; pendingEchoId: string }): {
			streamingBehavior: "steer";
			preflightResult(success: boolean): void;
			promptDisposition(disposition: "handled" | "queued" | "started"): void;
		};
	}
).buildMainLoopPromptOptions;

type Surface = {
	activeStatusIndicator: { kind: "working"; dispose(): void } | undefined;
	statusContainer: Container;
	editorContainer: Container;
	footerContainer: Container;
	pendingUserInputs: Array<{ text: string; pendingEchoId: string }>;
	agentIdle: boolean;
	workingVisible: boolean;
	workingMessage: string | undefined;
	defaultWorkingMessage: string;
	isInitialized: boolean;
	options: { tuiMode: "regular" };
	turnWorkingTip: { resetForNewTurn(): void };
	chrome: { createWorkingIndicator(): { kind: "working"; dispose(): void } };
	footer: { invalidate(): void };
	settingsManager: { getShowTerminalProgress(): boolean };
	ui: {
		requestRender(): void;
		getClearOnShrink(): boolean;
		terminal: { setProgress(value: boolean): void; columns: number; rows: number };
	};
	checkShutdownRequested(): Promise<void>;
	clearPendingTools(): void;
	clearActiveToolExecutionStatus(): void;
	clearToolHookStatuses(): void;
	streamingReveal: { stop(): void };
	toolResultReveal: { stop(): void };
	detachAssistantTextSegments(): void;
	streamingComponent: undefined;
	getWorkingIndicatorOptions(): Record<string, never>;
	showStatusIndicator(indicator: { kind: "working"; dispose(): void }): void;
	clearStatusIndicator(kind?: "working" | "retry"): void;
	optimisticUserEchoes: {
		promptOptions(id: string): {
			preflightResult(success: boolean): void;
			promptDisposition(disposition: "handled" | "queued" | "started"): void;
		};
		reject(id: string): void;
	};
	session: Harness["session"];
	getUserInput(): Promise<{ text: string; pendingEchoId: string }>;
	showError(message: string): void;
};

function createSurface(session: Harness["session"]): Surface {
	const surface = {
		activeStatusIndicator: { kind: "working" as const, dispose: vi.fn() },
		statusContainer: new Container(),
		editorContainer: new Container(),
		footerContainer: new Container(),
		pendingUserInputs: [],
		agentIdle: false,
		workingVisible: true,
		workingMessage: undefined,
		defaultWorkingMessage: "Working",
		isInitialized: true,
		options: { tuiMode: "regular" as const },
		turnWorkingTip: { resetForNewTurn: vi.fn() },
		chrome: { createWorkingIndicator: () => ({ kind: "working" as const, dispose: vi.fn() }) },
		footer: { invalidate: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		ui: {
			requestRender: vi.fn(),
			getClearOnShrink: () => false,
			terminal: { setProgress: vi.fn(), columns: 80, rows: 24 },
		},
		checkShutdownRequested: vi.fn(async () => {}),
		clearPendingTools: vi.fn(),
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		streamingReveal: { stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		detachAssistantTextSegments: vi.fn(),
		streamingComponent: undefined,
		getWorkingIndicatorOptions: () => ({}),
		showStatusIndicator: vi.fn(),
		clearStatusIndicator,
		optimisticUserEchoes: {
			promptOptions: () => ({ preflightResult: vi.fn(), promptDisposition: vi.fn() }),
			reject: vi.fn(),
		},
		session,
		getUserInput: vi.fn(),
		showError: vi.fn(),
	} satisfies Surface;
	surface.statusContainer.addChild(new Text("working\nworking\nworking\nworking", 0, 0));
	surface.editorContainer.addChild(new Text("editor\neditor\neditor", 0, 0));
	surface.footerContainer.addChild(new Text("footer", 0, 0));
	surface.showStatusIndicator = vi.fn((indicator) => {
		surface.activeStatusIndicator = indicator;
		surface.statusContainer.clear();
		surface.statusContainer.addChild(new Text("working\nworking\nworking\nworking", 0, 0));
	});
	return surface;
}

const LIFECYCLE_EVENT_TYPES = new Set(["agent_start", "agent_end", "agent_settled", "agent_idle"]);

function subscribeSurface(harness: Harness, surface: Surface): () => void {
	// Only forward the dock-lifecycle events the partial surface can handle; the
	// real handleEvent also renders messages/tools, which the surface does not stub.
	return harness.session.subscribe((event) => {
		if (LIFECYCLE_EVENT_TYPES.has(event.type)) return handleEvent.call(surface, event);
	});
}

function lifecycle(events: AgentSessionEvent[]): string[] {
	return events
		.map((event) => event.type)
		.filter(
			(type) => type === "agent_start" || type === "agent_end" || type === "agent_settled" || type === "agent_idle",
		);
}

function deferredContinuation(pi: ExtensionAPI): void {
	let sent = false;
	pi.on("agent_settled", () => {
		if (sent) return;
		sent = true;
		pi.sendMessage({ customType: "test-continuation", content: "continue", display: false }, { triggerTurn: true });
	});
}

// Settlement-deferred continuation via the always-triggering sendUserMessage API,
// which must ALSO hold off agent_idle until its turn starts (blocker B2b).
function deferredUserContinuation(pi: ExtensionAPI): void {
	let sent = false;
	pi.on("agent_settled", () => {
		if (sent) return;
		sent = true;
		pi.sendUserMessage("settlement user continuation", { deliverAs: "followUp" });
	});
}

describe("real AgentSession vertical-jitter lifecycle", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("C1 keeps settlement-deferred continuation ownership between settled and start", async () => {
		const harness = await createHarness({ extensionFactories: [deferredContinuation] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("continued")]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();

		expect(lifecycle(harness.events)).toEqual([
			"agent_start",
			"agent_end",
			"agent_settled",
			"agent_start",
			"agent_end",
			"agent_settled",
			"agent_idle",
		]);
	});

	it("C6 keeps settlement-deferred sendUserMessage ownership between settled and start", async () => {
		const harness = await createHarness({ extensionFactories: [deferredUserContinuation] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("continued")]);
		await harness.session.prompt("start");
		// The deferred sendUserMessage turn holds a session-work barrier token while
		// it awaits admission; drain that, then let the final settlement flush the
		// queued agent_idle microtask.
		await harness.session.waitForIdle();
		await harness.session.waitForSettledSessionWork().catch(() => {});
		await harness.session.waitForIdle();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(lifecycle(harness.events)).toEqual([
			"agent_start",
			"agent_end",
			"agent_settled",
			"agent_start",
			"agent_end",
			"agent_settled",
			"agent_idle",
		]);
	});

	it("C2 emits idle after an ordinary final settlement", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		expect(lifecycle(harness.events)).toEqual(["agent_start", "agent_end", "agent_settled", "agent_idle"]);
	});

	it("C3 emits exactly one idle when deferred continuation admission fails", async () => {
		const harness = await createHarness({ extensionFactories: [deferredContinuation] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const enforce = Reflect.get(harness.session, "_enforceFinalProviderAdmission");
		let admissions = 0;
		Reflect.set(harness.session, "_enforceFinalProviderAdmission", async (...args: unknown[]) => {
			admissions++;
			if (admissions === 2) throw new Error("deferred admission rejected");
			return enforce.apply(harness.session, args);
		});
		await harness.session.prompt("start");
		await harness.session.waitForSettledSessionWork();
		expect(harness.events.filter((event) => event.type === "agent_idle")).toHaveLength(1);
	});

	it("C4 clears retained Working when a locally buffered prompt is handled", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => pi.on("input", () => ({ action: "handled" }))],
		});
		harnesses.push(harness);
		const surface = createSurface(harness.session);
		surface.agentIdle = true;
		// Drive the REAL production composition from the main input loop
		// (interactive-mode.ts buildMainLoopPromptOptions). Deleting the production
		// handled-clear makes this test fail; nothing is duplicated here.
		const options = buildMainLoopPromptOptions.call(surface, { text: "blocked", pendingEchoId: "echo-1" });
		let disposition: string | undefined;
		const realDisposition = options.promptDisposition;
		options.promptDisposition = (value) => {
			disposition = value;
			realDisposition(value);
		};
		await harness.session.prompt("blocked", options);
		expect(disposition).toBe("handled");
		expect(surface.statusContainer.render(80)).toHaveLength(0);
	});

	it("C5 keeps editor/footer surface height stable through a deferred continuation", async () => {
		const harness = await createHarness({ extensionFactories: [deferredContinuation] });
		harnesses.push(harness);
		const surface = createSurface(harness.session);
		const unsubscribe = subscribeSurface(harness, surface);
		const heights: Array<{ event: string; height: number }> = [];
		const record = harness.session.subscribe((event) => {
			if (event.type !== "agent_end" && event.type !== "agent_settled" && event.type !== "agent_start") return;
			heights.push({
				event: event.type,
				height:
					surface.statusContainer.render(80).length +
					surface.editorContainer.render(80).length +
					surface.footerContainer.render(80).length,
			});
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("continued")]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		unsubscribe();
		record();
		const boundary = heights.slice(1, 4);
		expect(boundary.map(({ event }) => event)).toEqual(["agent_end", "agent_settled", "agent_start"]);
		expect(new Set(boundary.map(({ height }) => height)).size).toBe(1);
	});

	it("C7 keeps the dock when a handled prompt is not the last buffered input", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => pi.on("input", () => ({ action: "handled" }))],
		});
		harnesses.push(harness);
		const surface = createSurface(harness.session);
		surface.agentIdle = true;
		// Two buffered prompts: prompt1 is shifted and handled, but prompt2 is still
		// queued, so clearing the dock here would bounce it when prompt2 starts.
		surface.pendingUserInputs.push({ text: "p1", pendingEchoId: "e1" }, { text: "p2", pendingEchoId: "e2" });
		const first = surface.pendingUserInputs.shift();
		expect(surface.pendingUserInputs).toHaveLength(1);
		const options = buildMainLoopPromptOptions.call(surface, first!);
		let disposition: string | undefined;
		const realDisposition = options.promptDisposition;
		options.promptDisposition = (value) => {
			disposition = value;
			realDisposition(value);
		};
		await harness.session.prompt("p1", options);
		expect(disposition).toBe("handled");
		// Dock must survive because another buffered input remains.
		expect(surface.statusContainer.render(80).length).toBeGreaterThan(0);
	});

	it("C8 resolves the deferred claim when sendUserMessage content normalization throws", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					let sent = false;
					pi.on("agent_settled", () => {
						if (sent) return;
						sent = true;
						// null content throws in normalization before the guarded try.
						pi.sendUserMessage(null as unknown as string, { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		await new Promise<void>((resolve) => setImmediate(resolve));
		// The claim must resolve (finished-without-start), so agent_idle still fires
		// exactly once instead of hanging the settlement's Promise.all.
		expect(harness.events.filter((event) => event.type === "agent_idle")).toHaveLength(1);
	});
});
