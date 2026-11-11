/**
 * senpi#6411: switching models on an anthropic-subscription session with a live Claude Code process must not
 * wait for that process's `setModel`, which confirms the model with the API (80-280 ms, 15 s when unreachable).
 * The switch is applied before the next turn instead: a prompt sent right after `set_model` runs on the new model,
 * a failed switch reattaches the same lineage on a fresh process, and back-to-back switches apply in order.
 *
 * Drives a real AgentSession through the real provider stream and resident session registry against a scripted
 * SDK whose `setModel` settles only when the test releases it, so every ordering is asserted by events.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools, wrapStreamWithModelRecovery } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import type {
	SDKMessage,
	SdkQueryHandle,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { getSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	type ScriptedResidentQuery,
	sdkMessage,
	streamEvent,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, type Harness } from "../harness.ts";

type HeldSetModel = { release(): void; fail(error: Error): void };

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

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	resetScriptedSdk();
});

/** One resident Claude Code process that already answered a turn, with a `setModel` the test settles. */
async function residentSession() {
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
			entry.pendingModelSwitch = {
				// oxlint-disable-next-line unicorn/no-thenable -- intentional thenable observing the turn admission awaiting it
				then: (onFulfilled?: () => unknown, onRejected?: (reason: unknown) => unknown) => {
					events.push("admission waits");
					settle();
					return queued.then(onFulfilled, onRejected);
				},
			} as Promise<void>;
		},
	};
}

describe("senpi#6411 anthropic-subscription set_model does not wait for Claude Code", () => {
	it("answers set_model while the live process is still confirming the model", async () => {
		const { harness, events, model, setModelCall } = await residentSession();

		await harness.session.setModel(model("claude-next"));
		events.push("set_model returned");

		expect(events).toEqual(["stream:claude-test", "submitted:1", "setModel:claude-next", "set_model returned"]);
		(await setModelCall(0)).release();
	}, 30_000);

	it("runs a prompt sent right after the switch on the new model, after the process confirmed it", async () => {
		const { harness, events, queries, process0, model, setModelCall, atAdmission } = await residentSession();
		const sessionId = harness.sessionManager.getSessionId();
		await harness.session.setModel(model("claude-next"));
		const pending = await setModelCall(0);

		atAdmission(() => pending.release());
		await harness.session.prompt("second");

		expect(events.slice(2)).toEqual([
			"setModel:claude-next",
			"stream:claude-next",
			"admission waits",
			"confirmed:claude-next",
			"submitted:2",
		]);
		expect(queries).toHaveLength(1);
		expect(process0.submitted).toHaveLength(2);
		expect(getSession(sessionId)?.modelId).toBe("claude-next");
	}, 30_000);

	it("reattaches the same lineage on the new model when the live switch fails, without an unhandled rejection", async () => {
		const { harness, events, queries, process0, model, setModelCall, atAdmission } = await residentSession();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await harness.session.setModel(model("claude-next"));
			const pending = await setModelCall(0);
			atAdmission(() => pending.fail(new Error("Couldn't confirm model claude-next with the API")));
			await harness.session.prompt("second");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
		expect(events.slice(2)).toEqual(["setModel:claude-next", "stream:claude-next", "admission waits", "submitted:2"]);
		expect(queries).toHaveLength(2);
		expect(process0.submitted).toHaveLength(1);
		expect(queries[1]?.options).toMatchObject({ resume: process0.options?.sessionId, model: "claude-next" });
		expect(queries[1]?.submitted).toHaveLength(1);
		expect(getSession(harness.sessionManager.getSessionId())?.modelId).toBe("claude-next");
	}, 30_000);

	it("applies two quick switches in order, the second only after the first settled", async () => {
		const { harness, events, queries, process0, model, setModelCall, atAdmission } = await residentSession();
		await harness.session.setModel(model("claude-next"));
		await harness.session.setModel(model("claude-third"));
		expect(events.slice(2)).toEqual(["setModel:claude-next"]);

		const first = await setModelCall(0);
		atAdmission(() => first.release());
		const prompted = harness.session.prompt("second");
		(await setModelCall(1)).release();
		await prompted;

		expect(events.slice(2)).toEqual([
			"setModel:claude-next",
			"stream:claude-third",
			"admission waits",
			"confirmed:claude-next",
			"setModel:claude-third",
			"confirmed:claude-third",
			"submitted:2",
		]);
		expect(queries).toHaveLength(1);
		expect(process0.submitted).toHaveLength(2);
		expect(getSession(harness.sessionManager.getSessionId())?.modelId).toBe("claude-third");
	}, 30_000);
});
