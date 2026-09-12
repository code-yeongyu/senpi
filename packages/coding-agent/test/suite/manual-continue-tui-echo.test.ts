/**
 * The bare "." manual-continue shortcut must never paint a TUI user echo (#1569).
 *
 * `AgentSession.prompt()` routes a "." submitted on a session that already has
 * messages as a hidden continuation: no user message is created, persisted, or
 * replayed. The interactive submit boundary therefore must not paint its
 * render-only optimistic echo for that submission either — a painted bubble is
 * a message the transcript never receives. A "." on an empty session, and a
 * "." carrying image attachments, stay ordinary user input and keep their echo.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import * as interactiveModeModule from "../../src/modes/interactive/interactive-mode.ts";

type RenderHandle = { replace(message: AgentMessage): void; remove(): void };

type EchoController = {
	begin(text: string): string;
	promptOptions(id: string | undefined): {
		preflightResult(success: boolean): void;
		promptDisposition(disposition: "handled" | "queued" | "started"): void;
	};
	reject(id: string | undefined): void;
};

type EchoControllerConstructor = new (render: (text: string) => RenderHandle) => EchoController;

type Submission = { text: string; images?: ImageContent[]; pendingEchoId: string | undefined };

type PromptCall = { text: string; options: Record<string, unknown> | undefined };

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function createSubmitHarness(options: { messages: AgentMessage[]; isStreaming?: boolean; images?: ImageContent[] }): {
	submit: (text: string) => Promise<void>;
	painted: string[];
	submissions: Submission[];
	prompts: PromptCall[];
} {
	const painted: string[] = [];
	const submissions: Submission[] = [];
	const prompts: PromptCall[] = [];
	const controllerClass = Reflect.get(interactiveModeModule, "OptimisticUserEchoController");
	expect(controllerClass, "InteractiveMode must expose its TUI-local optimistic echo controller").toBeTypeOf(
		"function",
	);
	const Controller = controllerClass as EchoControllerConstructor;
	const optimisticUserEchoes = new Controller((text) => {
		painted.push(text);
		return { replace: () => {}, remove: () => {} };
	});
	const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
	// Borrowed from the prototype so the shipped classification runs against the stubbed collaborators.
	const beginUserEcho = Reflect.get(interactiveModeModule.InteractiveMode.prototype, "beginUserEcho");
	if (typeof beginUserEcho !== "function") throw new Error("InteractiveMode.beginUserEcho is missing");
	const context = {
		beginUserEcho,
		defaultEditor,
		preResolvedSubmissionImages: undefined,
		hideShortcutOverlay: () => {},
		lastEditorText: "",
		isExtensionCommand: () => false,
		session: {
			isCompacting: false,
			isStreaming: options.isStreaming ?? false,
			messages: options.messages,
			prompt: async (text: string, promptOptions: Record<string, unknown> | undefined) => {
				prompts.push({ text, options: promptOptions });
			},
		},
		flushPendingBashComponents: () => {},
		takeSubmissionImages: () => options.images ?? [],
		optimisticUserEchoes,
		onInputCallback: (submission: Submission) => submissions.push(submission),
		pendingUserInputs: [],
		editor: { addToHistory: () => {}, setText: () => {} },
		updatePendingMessagesDisplay: () => {},
		ui: { requestRender: () => {} },
	};
	const setup = Reflect.get(interactiveModeModule.InteractiveMode.prototype, "setupEditorSubmitHandler");
	if (typeof setup !== "function") throw new Error("InteractiveMode.setupEditorSubmitHandler is missing");
	setup.call(context);

	return {
		submit: async (text: string) => {
			const onSubmit = defaultEditor.onSubmit;
			if (!onSubmit) throw new Error("setupEditorSubmitHandler did not install an onSubmit handler");
			await onSubmit(text);
		},
		painted,
		submissions,
		prompts,
	};
}

describe("manual-continue TUI echo", () => {
	it("paints nothing for a bare '.' on a session that already has messages", async () => {
		const harness = createSubmitHarness({ messages: [userMessage("hello")] });

		await harness.submit(".");

		expect(harness.painted).toEqual([]);
		expect(harness.submissions).toHaveLength(1);
		expect(harness.submissions[0]?.text).toBe(".");
		expect(harness.submissions[0]?.pendingEchoId).toBeUndefined();
	});

	it("paints nothing for a padded '.' submission, which the editor trims to the shortcut", async () => {
		const harness = createSubmitHarness({ messages: [userMessage("hello")] });

		await harness.submit("  .  ");

		expect(harness.painted).toEqual([]);
		expect(harness.submissions[0]?.text).toBe(".");
	});

	it("paints nothing for a bare '.' steer continuation during an active turn", async () => {
		const harness = createSubmitHarness({
			messages: [userMessage("hello")],
			isStreaming: true,
		});

		await harness.submit(".");

		expect(harness.painted).toEqual([]);
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]?.text).toBe(".");
		expect(harness.prompts[0]?.options?.streamingBehavior).toBe("steer");
	});

	it("paints a bare '.' on an empty session, which stays an ordinary user message", async () => {
		const harness = createSubmitHarness({ messages: [] });

		await harness.submit(".");

		expect(harness.painted).toEqual(["."]);
		expect(harness.submissions[0]?.pendingEchoId).toBeTypeOf("string");
	});

	it("paints a '.' carrying image attachments, which stays an ordinary user message", async () => {
		const harness = createSubmitHarness({
			messages: [userMessage("hello")],
			images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
		});

		await harness.submit(".");

		expect(harness.painted).toEqual(["."]);
		expect(harness.submissions[0]?.pendingEchoId).toBeTypeOf("string");
	});

	it("paints ordinary text on a session that already has messages", async () => {
		const harness = createSubmitHarness({ messages: [userMessage("hello")] });

		await harness.submit("keep going please");

		expect(harness.painted).toEqual(["keep going please"]);
		expect(harness.submissions[0]?.pendingEchoId).toBeTypeOf("string");
	});
});
