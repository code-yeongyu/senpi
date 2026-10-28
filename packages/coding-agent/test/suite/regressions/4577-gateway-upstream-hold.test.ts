import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { RetryFallbackController } from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";
import { createHarness, type Harness } from "../harness.ts";

// #4577 (code-yeongyu/oh-my-openagent#11569): one gateway provider routes Claude and GPT to different upstream accounts.
const upstreamBilling =
	"400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const gatewayBilling = "400 Your credit balance is too low. Please go to Plans & Billing to purchase credits.";
const sessionLimit =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';
const claude = "anthropic/claude-opus-5-5";
const gpt = "gpt-6.1-sol";
const gatewayChain = { [`faux/${claude}`]: [`faux/${gpt}`] };

function bloatTranscript(harness: Harness, tokens: number): void {
	for (const text of ["older turn", "recent turn"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: text.repeat(200) }],
			timestamp: 1,
		});
		const response = fauxAssistantMessage("earlier response".repeat(200));
		harness.sessionManager.appendMessage({
			...response,
			provider: "faux",
			model: claude,
			usage: { ...response.usage, input: tokens, totalTokens: tokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

type Responder = (
	context: unknown,
	options: unknown,
	state: unknown,
	model: Model<Api>,
) => ReturnType<typeof fauxAssistantMessage>;

/**
 * Answers each request whose last message carries `prompt` from `turns` and every other (summarization)
 * request with `summary`, logging them as T:/S: selectors.
 */
function scripted(
	harness: Harness,
	prompt: string,
	summary: string,
	turns: ReturnType<typeof fauxAssistantMessage>[],
): string[] {
	const requests: string[] = [];
	const respond: Responder = (context, _options, _state, model) => {
		const selector = `${model.provider}/${model.id}`;
		const messages = Reflect.get(Object(context), "messages");
		if (!JSON.stringify(Array.isArray(messages) ? messages.at(-1) : undefined).includes(prompt)) {
			requests.push(`S:${selector}`);
			return fauxAssistantMessage(summary);
		}
		requests.push(`T:${selector}`);
		const next = turns.shift();
		if (!next) throw new Error("unexpected turn");
		return next;
	};
	harness.setResponses(Array.from({ length: 8 }, () => respond));
	return requests;
}

const unique = (requests: string[]): string[] => requests.filter((entry, index) => entry !== requests[index - 1]);

describe("#4577 gateway upstream hold", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("serves the turn on the gateway's other upstream when one upstream reports a billing error", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: claude }, { id: gpt }],
			settings: { compaction: { enabled: false }, retry: { enabled: true, fallbackChains: gatewayChain } },
			fallbackNow: () => 0,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: upstreamBilling }),
			fauxAssistantMessage("answered through the other upstream"),
		]);

		// when
		await harness.session.prompt("work through the gateway");

		// then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual([claude, gpt]);
		expect(harness.session.model?.id).toBe(gpt);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ to: `faux/${gpt}`, limit: "model" }]);
	});

	it.each(["manual", "threshold"] as const)(
		"compacts (%s) on the gateway once it serves again after an account-wide billing hold, and keeps its other rung",
		async (path) => {
			// given an account-wide hold on the gateway, then a turn the same gateway serves (HTTP 200)
			const harness = await createHarness({
				models: [
					{ id: claude, contextWindow: 100_000, maxTokens: 8_000 },
					{ id: gpt, contextWindow: 100_000, maxTokens: 8_000 },
				],
				tools: [],
				settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: true, fallbackChains: gatewayChain } },
				fallbackNow: () => 0,
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: gatewayBilling }),
				fauxAssistantMessage("served again"),
			]);
			await harness.session.prompt("spend the gateway");
			await harness.session.sendCustomMessage(
				{ customType: "continuation", content: "keep going", display: true },
				{ triggerTurn: true },
			);
			await harness.session.agent.waitForIdle();
			expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual([claude, claude]);
			bloatTranscript(harness, 95_000);
			const requests = scripted(harness, "continue after recovery", "a gateway summary", [
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: '429 {"type":"rate_limit_error","message":"You have hit your Opus weekly limit"}',
				}),
				fauxAssistantMessage("answered on the same-provider rung"),
			]);

			// when
			if (path === "manual") await harness.session.compact();
			await harness.session.prompt("continue after recovery");

			// then the summary ran on the gateway, and the same-provider rung served the next limit
			expect(unique(requests)).toEqual([`S:faux/${claude}`, `T:faux/${claude}`, `T:faux/${gpt}`]);
			expect(harness.sessionManager.getEntries().findLast((entry) => entry.type === "compaction")).toMatchObject({
				summary: expect.stringContaining("a gateway summary"),
			});
			expect(harness.session.model?.id).toBe(gpt);
		},
	);
});

function model(provider: string, id: string): Model<Api> {
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

function createController(models: Model<Api>[], chains: Record<string, readonly string[]>, start: Model<Api>) {
	let current: { model: Model<Api> } = { model: start };
	const events: unknown[] = [];
	const controller = new RetryFallbackController({
		getSettings: () => ({ modelFallback: true, chains }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => 0),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (next) => {
			current = { model: next };
		},
		emit: (event) => events.push(event),
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	});
	return { controller, events, current: () => current.model };
}

describe("#4577 hold scope and reconciliation", () => {
	const opus = model("gw", "anthropic/claude-opus-5-5");
	const sonnet = model("gw", "anthropic/claude-sonnet-5");
	const sol = model("gw", "gpt-6.1-sol");
	const gateway = [opus, sonnet, sol];

	it("holds only the failing upstream on a multi-upstream gateway", async () => {
		const { controller, events, current } = createController(
			gateway,
			{ "gw/anthropic/claude-opus-5-5": ["gw/anthropic/claude-sonnet-5", "gw/gpt-6.1-sol"] },
			opus,
		);

		const switched = await controller.tryFallback("billing", { errorMessage: upstreamBilling });

		expect({
			switched,
			to: `${current().provider}/${current().id}`,
			spent: controller.isProviderSpent("gw"),
		}).toEqual({
			switched: true,
			to: "gw/gpt-6.1-sol",
			spent: false,
		});
		expect(events).toMatchObject([{ type: "retry_fallback_applied", to: "gw/gpt-6.1-sol", limit: "model" }]);
	});

	it("keeps an upstream hold through a response from another upstream and clears it on a response from that upstream", () => {
		const { controller } = createController(
			gateway,
			{ "gw/anthropic/claude-opus-5-5": ["gw/anthropic/claude-sonnet-5"] },
			opus,
		);
		controller.noteHealthFailure(opus, undefined, { errorMessage: upstreamBilling });
		const held = controller.canTryFallback();

		controller.noteServed("gw/gpt-6.1-sol");
		const afterOtherUpstream = controller.canTryFallback();
		controller.noteServed("gw/anthropic/claude-opus-5-5");

		expect({ held, afterOtherUpstream, afterSameUpstream: controller.canTryFallback() }).toEqual({
			held: false,
			afterOtherUpstream: false,
			afterSameUpstream: true,
		});
	});

	it("clears an account-wide hold only when that provider serves", () => {
		const primary = model("a", "primary");
		const spare = model("b", "spare");
		const { controller } = createController([primary, spare], {}, primary);
		controller.noteHealthFailure(primary, undefined, { errorMessage: sessionLimit });

		controller.noteServed("b/spare");
		const afterOtherAccount = controller.isProviderSpent("a");
		controller.noteServed("a/primary");

		expect({ afterOtherAccount, afterSameAccount: controller.isProviderSpent("a") }).toEqual({
			afterOtherAccount: true,
			afterSameAccount: false,
		});
	});

	it("keeps the account-wide hold for a vendor-named billing error on a single-upstream provider", () => {
		const first = model("anthropic", "claude-opus-5-5");
		const sibling = model("anthropic", "claude-sonnet-5");
		const { controller } = createController(
			[first, sibling],
			{ "anthropic/claude-opus-5-5": ["anthropic/claude-sonnet-5"] },
			first,
		);

		controller.noteHealthFailure(first, undefined, { errorMessage: upstreamBilling });

		expect({ spent: controller.isProviderSpent("anthropic"), canTry: controller.canTryFallback() }).toEqual({
			spent: true,
			canTry: false,
		});
	});
});
