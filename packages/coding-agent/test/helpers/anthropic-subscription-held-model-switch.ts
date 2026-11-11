/**
 * senpi#6411 fixture: a real AgentSession on the anthropic-subscription provider with one resident Claude Code
 * stand-in that already answered a turn and whose `setModel` settles only when the test releases or fails it.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools, wrapStreamWithModelRecovery } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import type {
	SDKMessage,
	SdkQueryHandle,
} from "../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { getSession } from "../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { streamAnthropicSubscription } from "../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	type ScriptedResidentQuery,
	sdkMessage,
	streamEvent,
} from "./anthropic-subscription-scripted-sdk.ts";

export type HeldSetModel = { release(): void; fail(error: Error): void };

const answer = (sessionId: string, userUuid: string, text: string): SDKMessage[] => [
	streamEvent(sessionId, { type: "message_start", message: { usage: { input_tokens: 10 } } }),
	streamEvent(sessionId, { type: "content_block_start", index: 0, content_block: { type: "text" } }),
	streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
	streamEvent(sessionId, { type: "content_block_stop", index: 0 }),
	streamEvent(sessionId, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
	sdkMessage({
		type: "result",
		subtype: "success",
		result: text,
		user_message_uuid: userUuid,
		session_id: sessionId,
		usage: { input_tokens: 10, output_tokens: 4 },
	}),
];

const harnesses: Harness[] = [];

/** Call from `afterEach`. */
export function cleanupResidentSessions(): void {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	resetScriptedSdk();
}

/** One resident Claude Code process that already answered a turn, with a `setModel` the test settles. */
export async function residentSession() {
	await installSingleAccountLane();
	const events: string[] = [];
	let submissions = 0;
	const queries = installScriptedSdk((sessionId, userUuid) => {
		submissions += 1;
		events.push(`submitted:${submissions}`);
		return answer(sessionId, userUuid, `reply ${submissions}`);
	});
	const harness = await createHarness({
		api: CLAUDE_SDK_OAUTH_API_ID,
		provider: SCRIPTED_PROVIDER,
		models: [
			{ id: "claude-test", contextWindow: 200_000 },
			{ id: "claude-next", contextWindow: 200_000 },
			{ id: "claude-third", contextWindow: 200_000 },
		],
		extensionFactories: [(pi) => registerSessionRegistry(pi)],
	});
	harnesses.push(harness);
	const streamFn: StreamFn = (model, context, options) => {
		events.push(`stream:${model.id}`);
		const stream = wrapStreamWithModelRecovery(
			streamAnthropicSubscription(model, context, { cwd: process.cwd(), ...options }),
			model,
			getCurrentTools(context.messages),
		);
		return stream;
	};
	harness.agent.streamFunction = streamFn;
	harness.agent.sessionId = harness.sessionManager.getSessionId();
	await harness.session.prompt("first");
	const process0 = queries[0] as ScriptedResidentQuery;
	const held: HeldSetModel[] = [];
	const waiters: Array<(call: HeldSetModel) => void> = [];
	(process0 as SdkQueryHandle).setModel = (model) =>
		new Promise<void>((resolve, reject) => {
			events.push(`setModel:${model}`);
			const call = {
				release: () => {
					events.push(`confirmed:${model}`);
					resolve();
				},
				fail: (error: Error) => reject(error),
			};
			held.push(call);
			waiters.shift()?.(call);
		});
	return {
		harness,
		events,
		queries,
		process0,
		model: (id: string) => harness.getModel(id)!,
		/** The `index`-th `setModel` call the process received, once it arrives. */
		setModelCall: (index: number): Promise<HeldSetModel> =>
			held[index] ? Promise.resolve(held[index]) : new Promise((resolve) => waiters.push(resolve)),
		/** Runs `settle` only once the next turn admission waits on the session's pending switch. */
		atAdmission: (settle: () => void) => {
			const entry = getSession(harness.sessionManager.getSessionId())!;
			const queued = entry.pendingModelSwitch!;
			const done = {
				// oxlint-disable-next-line unicorn/no-thenable -- intentional thenable observing the turn admission awaiting it
				then: (onFulfilled?: () => unknown, onRejected?: (reason: unknown) => unknown) => {
					events.push("admission waits");
					settle();
					return queued.done.then(onFulfilled, onRejected);
				},
			} as Promise<void>;
			entry.pendingModelSwitch = { ...queued, done };
		},
	};
}
