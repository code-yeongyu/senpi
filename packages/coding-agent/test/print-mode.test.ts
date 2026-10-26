import type { AssistantMessage, ImageContent, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_COMPACTION_ERROR_MESSAGE } from "../src/core/agent-session.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

const outputGuard = vi.hoisted((): { stdout: string[] } => ({ stdout: [] }));

vi.mock("../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: vi.fn((text: string) => {
		outputGuard.stdout.push(text);
	}),
}));

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: Message[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	waitForSettledSessionWork: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createToolResultMessage(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "finish",
		content: [{ type: "text", text: "terminated" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(messages: AssistantMessage | Message[]): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: Array.isArray(messages) ? messages : [messages] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		waitForSettledSessionWork: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	outputGuard.stdout = [];
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images, sessionTitlePrompt: false });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello", { sessionTitlePrompt: false });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	// senpi#4061: output format must not change the final run's success status.
	it.each(["text", "json"] as const)(
		"emits session_shutdown and returns non-zero on assistant error (%s)",
		async (mode) => {
			const runtimeHost = createRuntimeHost(
				createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
			);
			const { session } = runtimeHost;
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode,
			});

			expect(exitCode).toBe(1);
			if (mode === "text") expect(errorSpy).toHaveBeenCalledWith("provider failure");
			else expect(errorSpy).not.toHaveBeenCalled();
			expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
			expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
		},
	);

	it("json mode returns non-zero when the run ran out of context (senpi#2925)", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: REQUIRED_COMPACTION_ERROR_MESSAGE }),
		);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "Survey the pages",
		});

		expect(exitCode).toBe(1);
	});

	it.each(["text", "json"] as const)("returns zero after an error recovers during settlement (%s)", async (mode) => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider down" }),
		);
		runtimeHost.session.waitForSettledSessionWork.mockImplementation(async () => {
			runtimeHost.session.state.messages.push(createAssistantMessage({ text: "recovered" }));
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode,
			initialMessage: "Say hi",
		});

		expect(exitCode).toBe(0);
	});

	it("prints the last assistant text when a terminating tool result trails it", async () => {
		const runtimeHost = createRuntimeHost([
			createAssistantMessage({ text: "final answer" }),
			createToolResultMessage(),
		]);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(outputGuard.stdout.join("")).toBe("final answer\n");
	});

	it.each(["text", "json"] as const)(
		"returns non-zero when an aborted assistant message is followed by a tool result (%s)",
		async (mode) => {
			const runtimeHost = createRuntimeHost([
				createAssistantMessage({ stopReason: "aborted", errorMessage: "user aborted" }),
				createToolResultMessage(),
			]);
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode,
			});

			expect(exitCode).toBe(1);
			if (mode === "text") expect(errorSpy).toHaveBeenCalledWith("user aborted");
			else expect(errorSpy).not.toHaveBeenCalled();
			expect(outputGuard.stdout.join("")).toBe("");
		},
	);
});
