// senpi#4002 review: the builtin keeps its stored draft on every cancel that carries no answers. This proves the
// lifecycle cancels still stay silent with that draft kept: no injected message, so no new turn, and the
// blocking result keeps today's text, while the settled response still carries the draft.
import { describe, expect, it } from "vitest";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionContext, ExtensionToolContext, QuestionResponse } from "../../src/core/extensions/types.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { type AskUserDelivery, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const QUESTIONS = [
	{ header: "Auth", question: "Which flow?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
	{ header: "Library", question: "Which?", options: [{ label: "C" }, { label: "D" }], multiSelect: false },
];
const DRAFT = { q1: { selected: ["A"] } };
const DISMISSED = "The user dismissed the question.";

type QuestionUi = NonNullable<ExtensionContext["ui"]["question"]>;
interface Lifecycle {
	readonly name: string;
	/** Today's blocking text for this cancel; none of them names the answer. */
	readonly blockingText: string;
	/** The question UI: reports q1 as progress and stays open. */
	readonly ui: (bridge: ConnectionQuestionBridge) => QuestionUi;
	readonly cancel: (
		delivery: AskUserDelivery,
		turn: AbortController,
		bridge: ConnectionQuestionBridge,
	) => Promise<void>;
}

const openWithDraft = (): QuestionUi => (_request, opts) => {
	opts?.onProgress?.({ answers: DRAFT });
	return new Promise<QuestionResponse>(() => {});
};

const LIFECYCLES: readonly Lifecycle[] = [
	{
		name: "a turn abort",
		blockingText: DISMISSED,
		ui: openWithDraft,
		cancel: async (_delivery, turn) => turn.abort(),
	},
	{
		name: "the session closing",
		blockingText: "The pending question was cancelled because the session closed.",
		ui: openWithDraft,
		cancel: async (delivery) => {
			await emitSessionShutdownEvent(delivery.harness.getExtensionRunner(), {
				type: "session_shutdown",
				reason: "quit",
			});
		},
	},
	{
		name: "ask-user being disabled",
		blockingText: "The pending question was cancelled because ask-user is disabled.",
		ui: openWithDraft,
		cancel: async (delivery) => {
			delivery.harness.settingsManager.applyOverrides({ askUser: { enabled: false } });
			const model = delivery.harness.getModel();
			await delivery.harness.getExtensionRunner().emitModelSelect({
				type: "model_select",
				model,
				previousModel: model,
				source: "set",
				systemPrompt: "",
				systemPromptOptions: { cwd: delivery.harness.tempDir },
			});
		},
	},
	{
		name: "a closed RPC connection",
		blockingText: DISMISSED,
		ui: (bridge) => (request, opts) => {
			const answer = bridge.ask(request, opts);
			const id = bridge.pendingQuestions()[0]?.id ?? "";
			bridge.progress({ type: "extension_ui_progress", id, answers: DRAFT });
			return answer;
		},
		cancel: async (_delivery, _turn, bridge) => bridge.cancelAll(),
	},
];

async function cancelAfterDraft(lifecycle: Lifecycle, waitForAnswer: boolean) {
	const delivery = await createAskUserDelivery();
	const bridge = new ConnectionQuestionBridge(() => {});
	const turn = new AbortController();
	const ctx = delivery.context(lifecycle.ui(bridge));
	const execution = delivery.tool.execute(
		"q",
		{ questions: QUESTIONS, waitForAnswer },
		turn.signal,
		undefined,
		ctx as ExtensionToolContext,
	);
	if (!waitForAnswer) await execution;
	const settled = delivery.settled(ctx, "q");
	await lifecycle.cancel(delivery, turn, bridge);
	const result = await execution;
	const response = await settled;
	delivery.harness.cleanup();
	return { delivery, result, response };
}

describe("a lifecycle cancel after a partial answer stays silent with the draft kept", () => {
	for (const lifecycle of LIFECYCLES) {
		it(`async: ${lifecycle.name} injects no message`, async () => {
			const { delivery, response } = await cancelAfterDraft(lifecycle, false);
			expect(response).toMatchObject({ status: "cancelled", answers: DRAFT });
			expect(response.cancelOrigin === "user" || response.cancelOrigin === "ui_failure").toBe(false);
			expect(delivery.deliveries).toEqual([]);
		});
		it(`blocking: ${lifecycle.name} keeps today's text`, async () => {
			const { delivery, result, response } = await cancelAfterDraft(lifecycle, true);
			expect(response).toMatchObject({ status: "cancelled", answers: DRAFT });
			expect(result.content.map((part) => ("text" in part ? part.text : "")).join("")).toBe(lifecycle.blockingText);
			expect(delivery.deliveries).toEqual([]);
		});
	}
});
