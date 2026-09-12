/**
 * Shared setup for the "exactly one framed user message per async question"
 * tests. The real ask-user builtin runs on a live session while
 * `pi.sendUserMessage` is replaced by a recorder, so a delivery is counted
 * instead of starting a real turn, and the pending-question registry gives the
 * test an awaited settlement signal instead of a timing guess.
 */

import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../../src/core/extensions/builtin/ask-user/registry.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	QuestionResponse,
	ToolDefinition,
} from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

type QuestionBridge = NonNullable<ExtensionContext["ui"]["question"]>;
type DeliveredContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type DeliveredOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];

export interface DeliveredMessage {
	content: DeliveredContent;
	options: DeliveredOptions;
}

export interface AskUserDelivery {
	harness: Harness;
	/** Every user message the extension delivered, in order. */
	deliveries: DeliveredMessage[];
	/** Every `wake_source_state` event the extension emitted, in order. */
	wakeEvents: unknown[];
	tool: ToolDefinition;
	/** Context bound to `question`; `idle` drives the steer/follow-up choice. */
	context(question: QuestionBridge, idle?: boolean): ExtensionContext;
	/** Completion of pending question `requestId`; settles after the delivery ran. */
	settled(ctx: ExtensionContext, requestId: string): Promise<QuestionResponse>;
}

export const ASYNC_QUESTIONS = [{ header: "Library", question: "Which library?", multiSelect: false }];

export async function createAskUserDelivery(timeoutMinutes = 30): Promise<AskUserDelivery> {
	const deliveries: DeliveredMessage[] = [];
	const wakeEvents: unknown[] = [];
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		extensionFactories: [
			{
				factory: (pi) => {
					api = pi;
					pi.events.on("wake_source_state", (event) => wakeEvents.push(event));
					askUserExtension(pi);
				},
			},
		],
		settings: { askUser: { enabled: true, timeoutMinutes } },
	});
	await harness.session.bindExtensions({});
	if (!api) throw new Error("extension factory never ran");
	api.sendUserMessage = (content, options) => {
		deliveries.push({ content, options });
	};
	const runner = harness.getExtensionRunner();
	const base = runner.createContext();
	const tool = runner.getAllRegisteredTools().find((t) => t.definition.name === "ask_user_question")?.definition;
	if (!tool) throw new Error("ask_user_question is not registered");
	return {
		harness,
		deliveries,
		wakeEvents,
		tool,
		context: (question, idle = true) => ({
			...base,
			mode: "tui",
			hasUI: true,
			isIdle: () => idle,
			ui: { ...base.ui, question },
		}),
		settled: (ctx, requestId) => {
			const entry = getPendingQuestions(ctx.sessionManager.getSessionId()).find(
				(pending) => pending.request.requestId === requestId,
			);
			if (!entry) throw new Error(`no pending question ${requestId}`);
			return entry.completion;
		},
	};
}
