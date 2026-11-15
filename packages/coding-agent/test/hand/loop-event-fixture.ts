// senpi#5898 slice 4: the user's machine that runs a hosted loop's events (a hand with the loop-event extension loaded
// by path, as `-e` loads it), a local session's runner with the same extension, and the events a loop forwards.
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, type JsonValue, type Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import loopEventExtension from "./fixtures/loop-event-extension.ts";
import { handConfiguration, handDirs } from "./remote-hand-fixture.ts";

export const LOOP_EVENT_EXTENSION = fileURLToPath(new URL("./fixtures/loop-event-extension.ts", import.meta.url));

export const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** A hand that is its extensions' home, with a user extension (the loop-event one by default) loaded by path. */
export async function loopEventMachine(extension = LOOP_EVENT_EXTENSION) {
	const dirs = await handDirs("k5-loop-events");
	const machine = createLooplessHand(handConfiguration(dirs, ["-e", extension]), {
		twoSidedHome: "hand",
	});
	const sessionId = `loop-${crypto.randomUUID()}`;
	const scope = { id: `session-${sessionId}`, root: dirs.cwd };
	return {
		dirs,
		scope,
		base: { sessionId, idle: false, scope },
		/** One forwarded event, as the loop sends it: the session base plus the event's own fields. */
		send: (event: string, fields: object) =>
			machine.loopHooks(event, toJson({ sessionId, idle: false, scope, ...fields })) as Promise<LoopReply>,
		describe: () => machine.loopHooks("describe_hooks", toJson({ scope })) as Promise<{ wants: string[] }>,
	};
}

/** A local session's runner (it has a session manager, so it dispatches loop events) with the same extension. */
export async function localRunner(cwd: string): Promise<ExtensionRunner> {
	const loaded = await createTestExtensionsResult([{ path: LOOP_EVENT_EXTENSION, factory: loopEventExtension }], cwd);
	return new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		SessionManager.inMemory(cwd),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
		loaded.eventBus,
	);
}

export interface LoopReply {
	readonly [key: string]: unknown;
	readonly notices?: readonly { readonly message: string }[];
	readonly errors?: readonly unknown[];
}

const model = (id: string): Model<"openai-completions"> => ({
	id,
	name: id,
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});

export const MODEL = model("model-b");
export const PREVIOUS_MODEL = model("model-a");
const message = fauxAssistantMessage("hello");

/** Each notification a loop forwards as its local event carries it (`message_update` travels as a delta instead). */
export const fieldsOf = (event: string): object => NOTIFICATIONS.find((row) => row.event === event)?.fields ?? {};

export const NOTIFICATIONS: readonly { readonly event: string; readonly fields: object }[] = [
	{ event: "agent_start", fields: {} },
	{ event: "agent_settled", fields: { fallbackExhausted: { resumeAt: 1700 } } },
	{ event: "turn_start", fields: { turnIndex: 3, timestamp: 1700 } },
	{ event: "message_start", fields: { message } },
	{
		event: "system_prompt_change",
		fields: {
			systemPrompt: "new prompt",
			previousSystemPrompt: "old prompt",
			systemPromptName: "preset",
			model: MODEL,
			previousModel: PREVIOUS_MODEL,
			source: "model_select",
		},
	},
	{ event: "thinking_level_select", fields: { level: "high", previousLevel: "off" } },
	{ event: "session_info_changed", fields: { name: "renamed" } },
	{
		event: "session_hold_changed",
		fields: { change: "paused", pauseSeq: 2, holds: [{ kind: "goal", key: "g-1", data: { why: "review" } }] },
	},
	{ event: "held_wakes_released", fields: { sources: { inbox: 2 } } },
	{
		event: "session_tree",
		fields: {
			newLeafId: "entry-2",
			oldLeafId: "entry-1",
			summaryEntry: {
				type: "branch_summary",
				id: "summary-1",
				parentId: "entry-2",
				timestamp: new Date(0).toISOString(),
				fromId: "entry-1",
				summary: "left branch",
			},
			fromExtension: false,
		},
	},
	{ event: "session_parked", fields: {} },
	{ event: "session_resumed", fields: {} },
	{ event: "session_abort", fields: {} },
	{
		event: "after_provider_response",
		fields: { status: 200, headers: { "x-request-id": "request-1", "anthropic-ratelimit-requests-remaining": "9" } },
	},
	{
		event: "provider_stream_event",
		fields: { provider: "fixture", api: "openai-completions", model: "model-b", data: { chunk: 1 } },
	},
	{ event: "input_disposition", fields: { inputId: "input-1", disposition: "queued" } },
	{ event: "session_control_wake", fields: { reason: "inbox", reasons: ["inbox", "idle"], delivery_ids: ["d-1"] } },
];
