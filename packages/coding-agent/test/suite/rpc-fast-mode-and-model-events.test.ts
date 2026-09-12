import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import serviceTierExtension from "../../src/core/extensions/builtin/service-tier.ts";
import {
	buildRpcSessionState,
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionSink,
} from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * The additive RPC surface for model and fast-tier changes:
 * - `model_changed` / `service_tier_changed` events,
 * - `serviceTier` + `fastMode` on `get_state`,
 * - `set_fast_mode` / `get_fast_mode` commands,
 * - `scope: "turn"` `set_thinking_level` validating BEFORE it mutates.
 *
 * Everything is driven through raw JSONL lines on a real connection handler, so the
 * assertions are on wire records, not on internal method calls.
 */

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const BASE_MODEL_ID = "gpt-5.6-sol";
const ALT_MODEL_ID = "gpt-5.5";
const BASE_KEY = `${CODEX_PROVIDER}/${BASE_MODEL_ID}`;
const ON_OFF_MAP = { minimal: null, low: null, medium: null, xhigh: null, max: null } as const;

interface WireRecord {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

function createRuntimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC fast-mode commands and model/tier events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		vi.restoreAllMocks();
	});

	interface RpcHarness {
		harness: Harness;
		handler: RpcConnectionHandler;
		lines: string[];
		/** Send one command line and return its response record. */
		send(command: Record<string, unknown>): Promise<WireRecord>;
		/** All non-response records emitted so far (events). */
		events(): WireRecord[];
	}

	async function createRpcHarness(options: Partial<HarnessOptions> = {}): Promise<RpcHarness> {
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [
				{ id: BASE_MODEL_ID, reasoning: true },
				{ id: ALT_MODEL_ID, reasoning: true },
			],
			fileSettings: true,
			settings: {},
			extensionFactories: [serviceTierExtension],
			...options,
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});

		const lines: string[] = [];
		const sink: RpcConnectionSink = {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		};
		const handler = createRpcConnectionHandler(createRuntimeHost(harness.session), sink);
		cleanups.push(() => handler.dispose());
		await handler.ready;

		const records = (): WireRecord[] =>
			lines
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as WireRecord);

		let sequence = 0;
		return {
			harness,
			handler,
			lines,
			events: () => records().filter((record) => record.type !== "response"),
			send: async (command) => {
				const id = `rpc-${++sequence}`;
				await handler.handleInputLine(JSON.stringify({ id, ...command }));
				const response = records().find((record) => record.id === id && record.type === "response");
				if (!response) throw new Error(`Missing RPC response for ${JSON.stringify(command)}`);
				return response;
			},
		};
	}

	function readSettings(harness: Harness): Record<string, unknown> {
		return JSON.parse(readFileSync(join(harness.tempDir, "agent", "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
	}

	// =====================================================================
	// (i) scope-turn set_thinking_level validates BEFORE mutating
	// =====================================================================

	it("rejects an unsupported turn-scoped thinking level without changing the level", async () => {
		// given: an on/off-only model parked on "off" — the clamp target for an unsupported
		// request ("low" -> "high") differs from the current level, so any mutation is visible.
		const rpc = await createRpcHarness({ models: [{ id: BASE_MODEL_ID, reasoning: true }] });
		rpc.harness.getModel().thinkingLevelMap = { ...ON_OFF_MAP };
		expect(rpc.harness.session.getAvailableThinkingLevels()).toEqual(["off", "high"]);
		rpc.harness.session.setThinkingLevel("off");
		const before = await rpc.send({ type: "get_state" });
		expect(before.data?.thinkingLevel).toBe("off");

		// when
		const response = await rpc.send({ type: "set_thinking_level", level: "low", scope: "turn" });

		// then: the failure leaves the session exactly as it was
		expect(response.success).toBe(false);
		expect(response.error).toContain("low");
		const after = await rpc.send({ type: "get_state" });
		expect(after.data?.thinkingLevel).toBe("off");
		expect(rpc.harness.session.thinkingLevel).toBe("off");
	});

	it("still applies a supported turn-scoped thinking level", async () => {
		// given
		const rpc = await createRpcHarness({ models: [{ id: BASE_MODEL_ID, reasoning: true }] });
		rpc.harness.getModel().thinkingLevelMap = { ...ON_OFF_MAP };
		rpc.harness.session.setThinkingLevel("high");

		// when
		const response = await rpc.send({ type: "set_thinking_level", level: "off", scope: "turn" });

		// then
		expect(response.success).toBe(true);
		expect((await rpc.send({ type: "get_state" })).data?.thinkingLevel).toBe("off");
	});

	it("rejects a level outside the thinking-level vocabulary in turn scope", async () => {
		// given
		const rpc = await createRpcHarness({ models: [{ id: BASE_MODEL_ID, reasoning: true }] });
		rpc.harness.session.setThinkingLevel("high");

		// when: a level that is not in the vocabulary at all (not merely unsupported here)
		const turn = await rpc.send({ type: "set_thinking_level", level: "ultra", scope: "turn" });

		// then: rejected, and the session keeps the level it had
		expect(turn.success).toBe(false);
		expect(turn.error).toContain("ultra");
		expect((await rpc.send({ type: "get_state" })).data?.thinkingLevel).toBe("high");
		expect(rpc.harness.session.thinkingLevel).toBe("high");
	});

	// =====================================================================
	// (ii) cycle_model emits model_changed with the post-switch level
	// =====================================================================

	it("emits model_changed with the post-switch thinking level on cycle_model", async () => {
		// given: two favorites, the second pinned to a different thinking level
		const rpc = await createRpcHarness();
		const alt = rpc.harness.getModel(ALT_MODEL_ID);
		expect(alt).toBeDefined();
		rpc.harness.session.setFavoriteModels([
			{ model: rpc.harness.getModel() },
			{ model: alt!, thinkingLevel: "high" },
		]);

		// when
		const response = await rpc.send({ type: "cycle_model" });

		// then: the response shape is unchanged AND an additive event carries the new state
		expect(response.success).toBe(true);
		expect((response.data as { model?: { id?: string } })?.model?.id).toBe(ALT_MODEL_ID);
		const changed = rpc.events().filter((event) => event.type === "model_changed");
		expect(changed).toHaveLength(1);
		expect((changed[0].model as { id?: string })?.id).toBe(ALT_MODEL_ID);
		expect(changed[0].thinkingLevel).toBe(rpc.harness.session.thinkingLevel);
		expect(changed[0].thinkingLevel).toBe("high");
		expect(changed[0].source).toBe("cycle");
	});

	it('emits model_changed with source "set" on set_model', async () => {
		// given
		const rpc = await createRpcHarness();

		// when
		const response = await rpc.send({ type: "set_model", provider: CODEX_PROVIDER, modelId: ALT_MODEL_ID });

		// then
		expect(response.success).toBe(true);
		const changed = rpc.events().filter((event) => event.type === "model_changed");
		expect(changed).toHaveLength(1);
		expect((changed[0].model as { id?: string })?.id).toBe(ALT_MODEL_ID);
		expect(changed[0].source).toBe("set");
		expect(changed[0].thinkingLevel).toBe(rpc.harness.session.thinkingLevel);
	});

	// =====================================================================
	// (iii) get_state carries serviceTier + fastMode
	// =====================================================================

	it("reports serviceTier and fastMode in get_state", async () => {
		// given
		const rpc = await createRpcHarness();

		// then: off by default, with the tier the session resolved
		const initial = await rpc.send({ type: "get_state" });
		expect(initial.data?.fastMode).toBe(false);
		expect(initial.data?.serviceTier).toBe(rpc.harness.session.serviceTier);

		// when
		await rpc.send({ type: "set_fast_mode", enabled: true });

		// then
		const enabled = await rpc.send({ type: "get_state" });
		expect(enabled.data?.fastMode).toBe(true);
		expect(enabled.data?.serviceTier).toBe("priority");
	});

	// =====================================================================
	// (iv) set_fast_mode roundtrips, persists, and reports its tier
	// =====================================================================

	it("mirrors host usage totals needed by the attached interactive footer", async () => {
		const rpc = await createRpcHarness();
		rpc.harness.session.sessionManager.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: CODEX_PROVIDER,
			model: BASE_MODEL_ID,
			stopReason: "stop",
			content: [{ type: "text", text: "usage" }],
			timestamp: Date.now(),
			usage: {
				input: 100,
				totalTokens: 460,
				output: 20,
				cacheRead: 300,
				cacheWrite: 40,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 },
			},
		});

		const state = (await rpc.send({ type: "get_state" })).data as Record<string, unknown>;
		expect(state.usageTotals).toEqual({
			input: 100,
			output: 20,
			cacheRead: 300,
			cacheWrite: 40,
			cost: 1.25,
			latestCacheHitRate: (300 / 440) * 100,
		});
	});

	it("projects the same state fields for get_state and open_session", async () => {
		// given: the two surfaces must not drift — `open_session` answers with an RpcSessionState too
		const rpc = await createRpcHarness();
		await rpc.send({ type: "set_fast_mode", enabled: true });

		// when
		const fromGetState = (await rpc.send({ type: "get_state" })).data;
		const fromBuilder = buildRpcSessionState(rpc.harness.session);

		// then: identical once both have crossed JSON (which drops undefined-valued fields)
		expect(fromBuilder.fastMode).toBe(true);
		expect(fromBuilder.serviceTier).toBe("priority");
		expect(JSON.parse(JSON.stringify(fromBuilder))).toEqual(fromGetState);
	});

	it("roundtrips set_fast_mode / get_fast_mode and persists per model", async () => {
		// given
		const rpc = await createRpcHarness();
		expect((await rpc.send({ type: "get_fast_mode" })).data).toEqual({ enabled: false, serviceTier: null });

		// when
		const enable = await rpc.send({ type: "set_fast_mode", enabled: true });

		// then
		expect(enable.success).toBe(true);
		expect(enable.data).toEqual({
			enabled: true,
			serviceTier: "priority",
			provider: CODEX_PROVIDER,
			modelId: BASE_MODEL_ID,
		});
		expect((await rpc.send({ type: "get_fast_mode" })).data).toEqual({ enabled: true, serviceTier: "priority" });
		// The `/fast` command and this command share ONE persistence path.
		expect(readSettings(rpc.harness).modelServiceTiers).toEqual({ [BASE_KEY]: "priority" });

		// and: a fresh session over the same settings starts fast
		const restarted = await createRpcHarness({
			settings: readSettings(rpc.harness) as HarnessOptions["settings"],
		});
		expect((await restarted.send({ type: "get_fast_mode" })).data).toEqual({
			enabled: true,
			serviceTier: "priority",
		});
		expect((await restarted.send({ type: "get_state" })).data?.fastMode).toBe(true);
	});

	it("turns fast mode off and records an explicit auto", async () => {
		// given
		const rpc = await createRpcHarness();
		await rpc.send({ type: "set_fast_mode", enabled: true });

		// when
		const disable = await rpc.send({ type: "set_fast_mode", enabled: false });

		// then
		expect(disable.success).toBe(true);
		expect(disable.data).toEqual({
			enabled: false,
			serviceTier: "auto",
			provider: CODEX_PROVIDER,
			modelId: BASE_MODEL_ID,
		});
		expect(readSettings(rpc.harness).modelServiceTiers).toEqual({ [BASE_KEY]: "auto" });
		expect((await rpc.send({ type: "get_fast_mode" })).data).toEqual({ enabled: false, serviceTier: null });
	});

	it("emits service_tier_changed when fast mode flips", async () => {
		// given
		const rpc = await createRpcHarness();

		// when
		await rpc.send({ type: "set_fast_mode", enabled: true });

		// then
		const onEvents = rpc.events().filter((event) => event.type === "service_tier_changed");
		expect(onEvents).toHaveLength(1);
		expect(onEvents[0].fastMode).toBe(true);
		expect(onEvents[0].tier).toBe("priority");

		// when: the same state is requested again
		await rpc.send({ type: "set_fast_mode", enabled: true });

		// then: a no-op must not emit — clients treat the event as a real state change
		expect(rpc.events().filter((event) => event.type === "service_tier_changed")).toHaveLength(1);

		// when
		await rpc.send({ type: "set_fast_mode", enabled: false });

		// then
		const offEvents = rpc.events().filter((event) => event.type === "service_tier_changed");
		expect(offEvents).toHaveLength(2);
		expect(offEvents[1].fastMode).toBe(false);
	});

	it("refuses fast mode on a non-Codex model without persisting anything", async () => {
		// given
		const rpc = await createRpcHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			models: [{ id: "claude-sonnet" }],
		});

		// when
		const response = await rpc.send({ type: "set_fast_mode", enabled: true });

		// then: the wire reports the refusal instead of a false success
		expect(response.success).toBe(false);
		expect(response.error).toBe("Fast mode is only available for OpenAI Codex models.");
		expect(readSettings(rpc.harness).modelServiceTiers).toBeUndefined();
		expect((await rpc.send({ type: "get_state" })).data?.fastMode).toBe(false);
	});

	it("refuses to disable fast mode under an active priority pin", async () => {
		// given: a favorite pinned to `:priority` — the pin outranks the per-model memory
		const rpc = await createRpcHarness();
		const pinned = rpc.harness.getModel(ALT_MODEL_ID);
		expect(pinned).toBeDefined();
		rpc.harness.session.setFavoriteModels([
			{ model: rpc.harness.getModel() },
			{ model: pinned!, serviceTier: "priority" },
		]);
		await rpc.send({ type: "cycle_model" });
		expect((await rpc.send({ type: "get_state" })).data?.serviceTier).toBe("priority");

		// when
		const response = await rpc.send({ type: "set_fast_mode", enabled: false });

		// then: refused with the pin's copy, and nothing persisted
		expect(response.success).toBe(false);
		expect(response.error).toBe("Fast mode is fixed by the active model selection's priority tier.");
		expect(readSettings(rpc.harness).modelServiceTiers).toBeUndefined();
		expect((await rpc.send({ type: "get_fast_mode" })).data).toEqual({ enabled: true, serviceTier: "priority" });
	});

	it("keeps events and state consistent across a mid-session model switch", async () => {
		// given: fast mode on for the base model, then a switch to a model with no memory
		const rpc = await createRpcHarness();
		await rpc.send({ type: "set_fast_mode", enabled: true });
		expect((await rpc.send({ type: "get_state" })).data?.fastMode).toBe(true);

		// when
		await rpc.send({ type: "set_model", provider: CODEX_PROVIDER, modelId: ALT_MODEL_ID });

		// then: the model_changed event names the model get_state now reports — no stale view
		const changed = rpc.events().filter((event) => event.type === "model_changed");
		expect((changed.at(-1)?.model as { id?: string })?.id).toBe(ALT_MODEL_ID);
		const state = await rpc.send({ type: "get_state" });
		expect((state.data?.model as { id?: string })?.id).toBe(ALT_MODEL_ID);
		// The session fast flag is session-scoped, so it survives the switch; the reported tier
		// and fast flag agree with each other and with get_fast_mode.
		expect(state.data?.serviceTier).toBe("priority");
		expect(state.data?.fastMode).toBe(true);
		expect((await rpc.send({ type: "get_fast_mode" })).data).toEqual({ enabled: true, serviceTier: "priority" });
	});

	it("rejects a non-boolean set_fast_mode payload without touching state", async () => {
		// given
		const rpc = await createRpcHarness();

		// when
		const stringly = await rpc.send({ type: "set_fast_mode", enabled: "yes" });
		const nulled = await rpc.send({ type: "set_fast_mode", enabled: null });
		const missing = await rpc.send({ type: "set_fast_mode" });

		// then
		for (const response of [stringly, nulled, missing]) {
			expect(response.success).toBe(false);
			expect(response.error).toContain("boolean");
		}
		expect(readSettings(rpc.harness).modelServiceTiers).toBeUndefined();
		expect((await rpc.send({ type: "get_state" })).data?.fastMode).toBe(false);
	});
});
