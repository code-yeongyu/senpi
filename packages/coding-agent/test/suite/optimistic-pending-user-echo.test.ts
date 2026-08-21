import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import * as interactiveModeModule from "../../src/modes/interactive/interactive-mode.ts";

type RenderHandle = {
	replace(message: AgentMessage): void;
	remove(): void;
};

type EchoController = {
	begin(text: string): string;
	promptOptions(id: string): {
		preflightResult(success: boolean): void;
		promptDisposition(disposition: "handled" | "queued" | "started"): void;
	};
	reject(id: string): void;
	remove(id: string): void;
	replaceNext(message: AgentMessage): boolean;
};

type EchoControllerConstructor = new (render: (text: string) => RenderHandle) => EchoController;

function getControllerConstructor(): EchoControllerConstructor {
	const controllerClass = Reflect.get(interactiveModeModule, "OptimisticUserEchoController");
	expect(controllerClass, "InteractiveMode must expose its TUI-local optimistic echo controller").toBeTypeOf(
		"function",
	);
	return controllerClass as EchoControllerConstructor;
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

function createController() {
	const rendered: Array<{
		text: string;
		replacedWith?: AgentMessage;
		removed: boolean;
	}> = [];
	const Controller = getControllerConstructor();
	const controller = new Controller((text) => {
		const entry: { text: string; replacedWith?: AgentMessage; removed: boolean } = { text, removed: false };
		rendered.push(entry);
		return {
			replace: (message) => {
				entry.replacedWith = message;
			},
			remove: () => {
				entry.removed = true;
			},
		};
	});
	return { controller, rendered };
}

describe("optimistic pending user echo", () => {
	it("renders from the real Enter submit handler before handing input to prompt work", async () => {
		const order: string[] = [];
		const Controller = getControllerConstructor();
		const optimisticUserEchoes = new Controller((text) => {
			order.push(`render:${text}`);
			return { replace: () => {}, remove: () => {} };
		});
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const context = {
			defaultEditor,
			preResolvedSubmissionImages: undefined,
			hideShortcutOverlay: () => {},
			lastEditorText: "",
			isExtensionCommand: () => false,
			session: { isCompacting: false, isStreaming: false },
			flushPendingBashComponents: () => {},
			takeSubmissionImages: () => [],
			optimisticUserEchoes,
			onInputCallback: () => order.push("prompt-handoff"),
			pendingUserInputs: [],
			editor: { addToHistory: () => {} },
		};
		const setup = Reflect.get(interactiveModeModule.InteractiveMode.prototype, "setupEditorSubmitHandler");
		if (typeof setup !== "function") throw new Error("InteractiveMode.setupEditorSubmitHandler is missing");
		setup.call(context);

		await defaultEditor.onSubmit?.("paint me now");

		expect(order).toEqual(["render:paint me now", "prompt-handoff"]);
	});

	it("renders synchronously before prompt work starts", async () => {
		const { controller, rendered } = createController();
		const requestStarted = vi.fn();

		const id = controller.begin("paint me now");
		expect(rendered).toEqual([{ text: "paint me now", removed: false }]);
		requestStarted();
		controller.promptOptions(id).promptDisposition("started");

		expect(requestStarted).toHaveBeenCalledOnce();
		expect(rendered[0]?.removed).toBe(false);
	});

	it("does not consume a pending bubble for a foreign user message_start", () => {
		const { controller, rendered } = createController();
		const id = controller.begin("local submission");
		const foreign = userMessage("foreign extension prompt");
		const appended: AgentMessage[] = [];

		if (!controller.replaceNext(foreign)) appended.push(foreign);
		expect(appended).toEqual([foreign]);
		controller.promptOptions(id).promptDisposition("started");
		controller.replaceNext(userMessage("local canonical"));

		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toMatchObject({ text: "local submission", removed: false });
		expect(rendered[0]?.replacedWith).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "local canonical" }],
		});
	});

	it("replaces the pending bubble exactly once at canonical message_start", () => {
		const { controller, rendered } = createController();
		const id = controller.begin("original");
		controller.promptOptions(id).promptDisposition("started");
		const canonical = userMessage("canonical");

		controller.replaceNext(canonical);

		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toMatchObject({ text: "original", replacedWith: canonical, removed: false });
	});

	it("unpaints a compaction-in-progress rejection or thrown prompt", () => {
		const { controller, rendered } = createController();
		const preflightId = controller.begin("rejected by preflight");
		controller.promptOptions(preflightId).preflightResult(false);
		const thrownId = controller.begin("prompt threw");
		controller.reject(thrownId);

		expect(rendered.map((entry) => entry.removed)).toEqual([true, true]);
	});

	it("removes only the specified queue-owned pending echo", () => {
		const { controller, rendered } = createController();
		const queuedId = controller.begin("queued for compaction");
		const inFlightId = controller.begin("independent in-flight prompt");

		controller.remove(queuedId);
		controller.promptOptions(inFlightId).promptDisposition("started");
		controller.replaceNext(userMessage("independent canonical"));

		expect(rendered[0]?.removed).toBe(true);
		expect(rendered[1]?.removed).toBe(false);
		expect(rendered[1]?.replacedWith).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "independent canonical" }],
		});
	});

	it("unpaints handled extension-consumed input", () => {
		const { controller, rendered } = createController();
		const id = controller.begin("handled by extension");

		controller.promptOptions(id).promptDisposition("handled");

		expect(rendered[0]?.removed).toBe(true);
	});

	it("unpaints queued steer echoes so waiting input renders only as the pending queue", () => {
		const { controller, rendered } = createController();
		const firstId = controller.begin("first steer");
		const secondId = controller.begin("second steer");
		controller.promptOptions(firstId).promptDisposition("queued");
		controller.promptOptions(secondId).promptDisposition("queued");

		expect(rendered.map((entry) => entry.removed)).toEqual([true, true]);

		const appended: AgentMessage[] = [];
		const firstCanonical = userMessage("first steer");
		if (!controller.replaceNext(firstCanonical)) appended.push(firstCanonical);
		expect(appended).toEqual([firstCanonical]);
		expect(rendered.map((entry) => entry.replacedWith)).toEqual([undefined, undefined]);
	});

	it("keeps a started echo intact while a later queued echo is unpainted", () => {
		const { controller, rendered } = createController();
		const startedId = controller.begin("started prompt");
		controller.promptOptions(startedId).promptDisposition("started");
		const queuedId = controller.begin("queued steer");
		controller.promptOptions(queuedId).promptDisposition("queued");

		expect(rendered[0]?.removed).toBe(false);
		expect(rendered[1]?.removed).toBe(true);

		const canonical = userMessage("started prompt");
		expect(controller.replaceNext(canonical)).toBe(true);
		expect(rendered[0]?.replacedWith).toEqual(canonical);
	});

	it("queues compaction input without painting a sent-looking echo", () => {
		const beginCalls: string[] = [];
		const compactionQueuedMessages: unknown[] = [];
		const context = {
			optimisticUserEchoes: {
				begin: (text: string) => {
					beginCalls.push(text);
					return "pending-user-stub";
				},
			},
			compactionQueuedMessages,
			session: { reserveQueuedInputOrder: () => 1 },
			getSessionLogger: () => ({ debug: () => {} }),
			editor: { addToHistory: () => {}, setText: () => {} },
			updatePendingMessagesDisplay: () => {},
			showStatus: () => {},
		};
		const queue = Reflect.get(interactiveModeModule.InteractiveMode.prototype, "queueCompactionMessage");
		if (typeof queue !== "function") throw new Error("InteractiveMode.queueCompactionMessage is missing");
		queue.call(context, "queued during compaction", "steer");

		expect(beginCalls).toEqual([]);
		expect(compactionQueuedMessages).toHaveLength(1);
	});

	it("is render-only and does not persist before the canonical message", () => {
		const persisted: AgentMessage[] = [];
		const { controller, rendered } = createController();

		controller.begin("render only");

		expect(rendered).toHaveLength(1);
		expect(persisted).toEqual([]);
	});
});
