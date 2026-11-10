/**
 * oh-my-openagent#12166: the anthropic-subscription Claude Code child loads the user's claude.ai account connectors.
 *
 * The child runs with `--setting-sources=`, so a user's `~/.claude/settings.json` cannot turn them off, and each
 * attach adds the connectors' tool schemas to the context. `claudeAiConnectors: false` (or
 * `SENPI_CLAUDE_SDK_OAUTH_CLAUDEAI_CONNECTORS=false`) sends Claude Code's own `disableClaudeAiConnectors` setting
 * to the child. Unset keeps Claude Code's default, so the spawn settings stay exactly as before.
 *
 * Drives a real AgentSession through the real provider stream and the resident session registry against a
 * scripted SDK that records each spawn's options.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools, wrapStreamWithModelRecovery } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_SDK_OAUTH_API_ID } from "../../../src/core/extensions/builtin/anthropic-subscription/api-id.ts";
import type { SDKMessage } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { loadAnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import {
	installAmbientLane,
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	SCRIPTED_PROVIDER,
	type ScriptedResidentQuery,
	sdkMessage,
	streamEvent,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, type Harness } from "../harness.ts";

const CONNECTORS_ENV = "SENPI_CLAUDE_SDK_OAUTH_CLAUDEAI_CONNECTORS";

function answer(sessionId: string, userUuid: string): SDKMessage[] {
	return [
		streamEvent(sessionId, { type: "message_start", message: { usage: { input_tokens: 10 } } }),
		streamEvent(sessionId, { type: "content_block_start", index: 0, content_block: { type: "text" } }),
		streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
		streamEvent(sessionId, { type: "content_block_stop", index: 0 }),
		streamEvent(sessionId, {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 4 },
		}),
		sdkMessage({
			type: "result",
			subtype: "success",
			result: "ok",
			user_message_uuid: userUuid,
			session_id: sessionId,
			usage: { input_tokens: 10, output_tokens: 4 },
		}),
	];
}

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
	vi.unstubAllEnvs();
});

async function session(): Promise<{ harness: Harness; queries: ScriptedResidentQuery[] }> {
	const queries = installScriptedSdk(answer);
	const harness = await createHarness({
		api: CLAUDE_SDK_OAUTH_API_ID,
		provider: SCRIPTED_PROVIDER,
		models: [{ id: "claude-test", contextWindow: 200_000 }],
		extensionFactories: [(pi) => registerSessionRegistry(pi)],
	});
	harnesses.push(harness);
	harness.agent.streamFunction = residentStreamFn;
	harness.agent.sessionId = harness.sessionManager.getSessionId();
	return { harness, queries };
}

/** The resident process that received the latest submission, i.e. the one that served the last turn. */
function servingQuery(queries: readonly ScriptedResidentQuery[]): ScriptedResidentQuery | undefined {
	return queries.filter((query) => query.submitted.length > 0).at(-1);
}

describe("oh-my-openagent#12166 claude.ai connectors in the anthropic-subscription child", () => {
	it("keeps Claude Code's default and the spawn settings unchanged when the setting is unset", async () => {
		await installSingleAccountLane();
		const { harness, queries } = await session();

		await harness.session.prompt("first");

		expect(servingQuery(queries)?.options?.settings).toEqual({ autoCompactEnabled: false, autoMemoryEnabled: false });
	}, 30_000);

	it("sends disableClaudeAiConnectors to the managed-lane child when the env opts out", async () => {
		vi.stubEnv(CONNECTORS_ENV, "false");
		await installSingleAccountLane();
		const { harness, queries } = await session();

		await harness.session.prompt("first");

		expect(servingQuery(queries)?.options?.settings).toMatchObject({ disableClaudeAiConnectors: true });
	}, 30_000);

	it("sends disableClaudeAiConnectors to the ambient-lane child and keeps the host environment", async () => {
		vi.stubEnv(CONNECTORS_ENV, "0");
		installAmbientLane({ PATH: "/usr/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
		const { harness, queries } = await session();

		await harness.session.prompt("first");

		const serving = servingQuery(queries);
		expect(serving?.options?.settings).toMatchObject({ disableClaudeAiConnectors: true });
		// The documented host-environment workaround still reaches the child unchanged.
		expect(serving?.options?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
	}, 30_000);

	it("restarts the resident process when the setting flips mid-session", async () => {
		await installSingleAccountLane();
		const { harness, queries } = await session();

		await harness.session.prompt("first");
		const first = servingQuery(queries);
		vi.stubEnv(CONNECTORS_ENV, "false");
		await harness.session.prompt("second");

		const second = servingQuery(queries);
		expect(second).not.toBe(first);
		expect(first?.submitted).toHaveLength(1);
		expect(first?.options?.settings).not.toHaveProperty("disableClaudeAiConnectors");
		expect(second?.options?.settings).toMatchObject({ disableClaudeAiConnectors: true });
	}, 30_000);

	it("reads claudeAiConnectors from settings.json with env precedence and drops invalid values", () => {
		const settings = (global: unknown, project: unknown = {}) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ anthropicSubscriptionProvider: global }));
			storage.withLock("project", () => JSON.stringify({ anthropicSubscriptionProvider: project }));
			return SettingsManager.fromStorage(storage);
		};

		expect(loadAnthropicSubscriptionProviderSettings(settings({ claudeAiConnectors: false }), {})).toMatchObject({
			claudeAiConnectors: false,
		});
		expect(
			loadAnthropicSubscriptionProviderSettings(settings({ claudeAiConnectors: false }), {
				[CONNECTORS_ENV]: "true",
			}),
		).toMatchObject({ claudeAiConnectors: true });
		expect(
			loadAnthropicSubscriptionProviderSettings(settings({ claudeAiConnectors: "off" }), {
				[CONNECTORS_ENV]: "maybe",
			}),
		).not.toHaveProperty("claudeAiConnectors");
	});
});
