import { describe, expect, it } from "vitest";
import { getModel, getModels, getProviders, streamSimple } from "../src/compat.ts";
import { clampThinkingLevel, getSupportedThinkingLevels, inferThinkingLevelMap } from "../src/models.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { classifyErrorMessage, isRetryableAssistantError } from "../src/utils/retry.ts";

// omo#12316: a thinking-only model (its level map vetoes `off`) must never receive
// `thinking: {type: "disabled"}` - Kimi K3.1 Pro answers that with a 400 on every attempt.

interface ThinkingPayload {
	thinking?: { type: string };
	output_config?: { effort?: string };
}

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };

async function thinkingOffPayload(
	model: Model<"anthropic-messages">,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<ThinkingPayload> {
	let captured: ThinkingPayload | undefined;
	const result = streamSimple(model, context, {
		apiKey: "fake-key",
		reasoning,
		fetch: async (input, init) => {
			captured = (await new Request(input, init).json()) as ThinkingPayload;
			return new Response("fixture complete", { status: 400 });
		},
	});
	await result.result();
	if (!captured) throw new Error(`${model.provider}/${model.id}: no payload captured`);
	return captured;
}

// Every catalog row, any API, whose level map vetoes `off`: the agent loop sends these at clampThinkingLevel(model, "off").
const thinkingOnlyRows = getProviders()
	.flatMap((provider) => getModels(provider))
	.filter((model) => model.reasoning && inferThinkingLevelMap(model)?.off === null);

describe("thinking-off on a thinking-only model (omo#12316)", () => {
	it("the catalog has thinking-only rows to sweep, K3.1 Pro among them", () => {
		const ids = thinkingOnlyRows.map((model) => `${model.provider}/${model.id}`);
		expect(ids).toEqual(expect.arrayContaining(["kimi-coding/k3.1-pro", "kimi-coding/k3.1-pro-highspeed"]));
	});

	it.each(thinkingOnlyRows.map((model) => [`${model.provider}/${model.id}`, model] as const))(
		"%s clamps thinking-off to its lowest supported level",
		(_label, model) => {
			const levels = getSupportedThinkingLevels(model);
			expect(levels).not.toContain("off");
			expect(clampThinkingLevel(model, "off")).toBe(levels[0]);
		},
	);

	it("K3.1 Pro sends no thinking block and effort low, which the endpoint accepts", async () => {
		for (const id of ["k3.1-pro", "k3.1-pro-highspeed"] as const) {
			const payload = await thinkingOffPayload(getModel("kimi-coding", id));
			expect(payload.thinking, id).toBeUndefined();
			expect(payload.output_config, id).toEqual({ effort: "low" });
		}
	});

	it("a K3.1 Pro row without catalog compat or level map (models.json, gateways) never sends disabled", async () => {
		const { thinkingLevelMap: _map, compat: _compat, ...bare } = getModel("kimi-coding", "k3.1-pro");
		const payload = await thinkingOffPayload({ ...bare, provider: "some-gateway" });
		expect(payload.thinking?.type).not.toBe("disabled");
	});

	it.each(["k3.1-pro", "k3.1-pro-highspeed"] as const)(
		"%s keeps the accepted wire shape after clamping",
		async (id) => {
			const model = getModel("kimi-coding", id);
			const level = clampThinkingLevel(model, "off");
			expect(level).toBe("low");
			const payload = await thinkingOffPayload(model, level === "off" ? undefined : level);
			expect(payload.thinking).toBeUndefined();
			expect(payload.output_config).toEqual({ effort: "low" });
		},
	);

	// K3 and K3-256k keep the catalog's verified picker (low, high, max; no off): a carried-over off is sent at low, like
	// every thinking-only row. A caller that builds the request itself, with no level, still gets the wire's disabled block
	// as on main; this PR changes only rows that declare supportsDisabledThinking: false.
	it.each(["k3", "k3-256k"] as const)(
		"%s clamps a carried-over off to low and keeps main's wire request",
		async (id) => {
			const model = getModel("kimi-coding", id);
			expect(clampThinkingLevel(model, "off")).toBe("low");
			const payload = await thinkingOffPayload(model);
			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.output_config).toBeUndefined();
		},
	);
});

describe("a disabled-thinking rejection is terminal (omo#12316)", () => {
	const kimi =
		'400 {"error":{"type":"invalid_request_error","message":"K3.1 Pro does not support disabled thinking mode. Please enable thinking and try again, or choose another model."},"type":"error"}';
	const anthropic =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.disabled\\" is not supported for this model"}}';

	it.each([
		["Kimi 400", kimi],
		["Anthropic 400", anthropic],
		["Kimi wrapped by a gateway as 500", `500 server_error: upstream said ${kimi}`],
	])("%s is non-retryable", (_label, errorMessage) => {
		expect(classifyErrorMessage(errorMessage)).toBe("non-retryable");
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "kimi-coding",
			model: "k3.1-pro",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: 0,
		};
		expect(isRetryableAssistantError(message)).toBe(false);
	});
});
