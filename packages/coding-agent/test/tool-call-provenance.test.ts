import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { ToolOutputMode } from "../src/modes/interactive/components/tool-execution-types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { ToolCallProvenance } from "../src/modes/interactive/tool-call-provenance.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type InteractiveModePrototype = {
	captureToolCallTrust(this: ProvenanceContext, toolName: string, toolCallId: string): boolean;
	handleEvent(this: Record<string, unknown>, event: object): Promise<void>;
	createToolExecutionComponent(
		this: ProvenanceContext,
		toolName: string,
		toolCallId: string,
		args: unknown,
	): ToolExecutionComponent;
};

type ProvenanceContext = {
	toolCallProvenance: ToolCallProvenance;
	toolOutputMode: ToolOutputMode;
	isInitialized: boolean;
	chrome: undefined;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: {
		getSessionId(): string;
		getCwd(): string;
	};
	session: {
		getAllTools(): Array<{ name: string; sourceInfo: { source: string } }>;
		getToolDefinition(name: string): undefined;
	};
	ui: TUI;
	isRegisteredToolTrustedBuiltIn(toolName: string): boolean;
	getRegisteredToolDefinition(toolName: string, trustedBuiltIn: boolean): undefined;
	getCapturedToolCallTrust(toolCallId: string): boolean;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext() {
	let sessionId = "session-a";
	let currentSource = "builtin";
	const context: ProvenanceContext = {
		toolCallProvenance: new ToolCallProvenance(),
		toolOutputMode: "atomic",
		isInitialized: true,
		chrome: undefined,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => process.cwd(),
		},
		session: {
			getAllTools: () => [{ name: "eval", sourceInfo: { source: currentSource } }],
			getToolDefinition: () => undefined,
		},
		ui: { requestRender: () => {} } as TUI,
		isRegisteredToolTrustedBuiltIn: Reflect.get(InteractiveMode.prototype, "isRegisteredToolTrustedBuiltIn"),
		getRegisteredToolDefinition: Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition"),
		getCapturedToolCallTrust: Reflect.get(InteractiveMode.prototype, "getCapturedToolCallTrust"),
	};
	return {
		context,
		setCurrentSource(source: string) {
			currentSource = source;
		},
		setSessionId(id: string) {
			sessionId = id;
		},
	};
}

function renderEval(component: ToolExecutionComponent): string {
	component.updateResult({
		content: [],
		details: { toolCalls: Array.from({ length: 7 }, () => ({})) },
		isError: false,
	});
	return stripAnsi(component.render(80).join("\n"));
}

describe("interactive tool-call provenance", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("captures live builtin trust and keeps it across a registry reload in the same session", async () => {
		const { context, setCurrentSource } = createContext();
		const chatContainer = new Container();
		const liveContext = Object.assign(context, {
			footer: { invalidate: () => {} },
			pendingTools: new Map<string, ToolExecutionComponent>(),
			chatContainer,
			handleToolExecutionStart: () => {},
			captureToolCallTrust: interactiveModePrototype.captureToolCallTrust,
			createToolExecutionComponent: interactiveModePrototype.createToolExecutionComponent,
			toolArgsReveal: { finish: () => {} },
		});
		await interactiveModePrototype.handleEvent.call(liveContext as unknown as Record<string, unknown>, {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "eval",
			args: { title: "Inspect" },
		});
		chatContainer.clear();

		setCurrentSource("local");
		const rebuilt = interactiveModePrototype.createToolExecutionComponent.call(context, "eval", "call-1", {
			title: "Inspect",
		});

		expect(renderEval(rebuilt)).toContain("7 calls");
		rebuilt.dispose();
	});

	test("defaults uncaptured historical calls to untrusted even when a builtin now owns the name", () => {
		const { context } = createContext();
		const historical = interactiveModePrototype.createToolExecutionComponent.call(context, "eval", "old-call", {
			title: "Inspect",
		});

		expect(renderEval(historical)).not.toContain("7 calls");
	});

	test("does not promote a removed same-name extension call to builtin trust", () => {
		const { context, setCurrentSource } = createContext();
		setCurrentSource("local");
		interactiveModePrototype.captureToolCallTrust.call(context, "eval", "extension-call");

		setCurrentSource("builtin");
		const rebuilt = interactiveModePrototype.createToolExecutionComponent.call(context, "eval", "extension-call", {
			title: "Inspect",
		});

		expect(renderEval(rebuilt)).not.toContain("7 calls");
	});

	test("namespaces identical call ids by session", () => {
		const { context, setCurrentSource, setSessionId } = createContext();
		setCurrentSource("local");
		interactiveModePrototype.captureToolCallTrust.call(context, "eval", "shared-call");

		setSessionId("session-b");
		setCurrentSource("builtin");
		interactiveModePrototype.captureToolCallTrust.call(context, "eval", "shared-call");

		setSessionId("session-a");
		const sessionA = interactiveModePrototype.createToolExecutionComponent.call(context, "eval", "shared-call", {});
		setSessionId("session-b");
		const sessionB = interactiveModePrototype.createToolExecutionComponent.call(context, "eval", "shared-call", {});

		expect(renderEval(sessionA)).not.toContain("7 calls");
		expect(renderEval(sessionB)).toContain("7 calls");
	});
});
