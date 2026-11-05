/**
 * A config hot-reload (any non-routine settings.json, models.json, keybindings.json or omo.jsonc write)
 * must not restart the resident Claude Code process of an anthropic-subscription session.
 *
 * Every restart costs a Claude Code spawn plus a transcript resume, and on a real account it
 * re-attaches the claude.ai connectors, whose tool schemas then land on the following turn.
 * Desktop writes those files on routine actions (favourites, telemetry consent, model routing),
 * and every write reloads every session sharing the agent dir.
 *
 * Drives a real AgentSession through the real provider stream and the resident session registry
 * against a scripted SDK that records each spawned process.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools, wrapStreamWithModelRecovery } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import type { SDKMessage } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	sdkMessage,
	streamEvent,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, type Harness } from "../harness.ts";

const answer =
	(text: string) =>
	(sessionId: string, userUuid: string): SDKMessage[] => [
		streamEvent(sessionId, { type: "message_start", message: { usage: { input_tokens: 10 } } }),
		streamEvent(sessionId, { type: "content_block_start", index: 0, content_block: { type: "text" } }),
		streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		streamEvent(sessionId, { type: "content_block_stop", index: 0 }),
		streamEvent(sessionId, {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 4 },
		}),
		sdkMessage({
			type: "result",
			subtype: "success",
			result: text,
			user_message_uuid: userUuid,
			session_id: sessionId,
			usage: { input_tokens: 10, output_tokens: 4 },
		}),
	];

const residentStreamFn: StreamFn = (model, context, options) =>
	wrapStreamWithModelRecovery(
		streamAnthropicSubscription(model, context, { cwd: process.cwd(), ...options }),
		model,
		getCurrentTools(context.messages),
	);

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	resetScriptedSdk();
});

describe("anthropic-subscription resident process across a config hot-reload", () => {
	it("serves the turn after a reload from the same resident process", async () => {
		await installSingleAccountLane();
		const replies = [answer("first"), answer("second")];
		let call = 0;
		const queries = installScriptedSdk((sessionId, userUuid) => {
			const reply = replies[call];
			call += 1;
			if (!reply) throw new Error(`unscripted SDK submission ${call}`);
			return reply(sessionId, userUuid);
		});
		const harness = await createHarness({
			api: CLAUDE_SDK_OAUTH_API_ID,
			provider: SCRIPTED_PROVIDER,
			models: [{ id: "claude-test", contextWindow: 200_000 }],
			extensionFactories: [(pi) => registerSessionRegistry(pi)],
		});
		harnesses.push(harness);
		harness.agent.streamFunction = residentStreamFn;
		harness.agent.sessionId = harness.sessionManager.getSessionId();

		await harness.session.prompt("first");
		const first = queries.filter((query) => query.submitted.length > 0).at(-1);

		await harness.session.reload();
		await harness.session.prompt("second");

		expect(queries).toHaveLength(1);
		expect(first?.submitted).toHaveLength(2);
		expect(call).toBe(2);
	}, 30_000);
});
