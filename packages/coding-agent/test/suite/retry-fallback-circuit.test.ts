import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const models = [{ id: "faux-1" }, { id: "faux-2" }];

const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
const answer = (text: string) => fauxAssistantMessage(text);

describe("fallback-chain circuit breaker across sessions sharing one runtime", () => {
	const harnesses: Harness[] = [];
	let now = 0;

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		now = 0;
	});

	function settings(extra: Partial<Settings> = {}): Partial<Settings> {
		return {
			retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [fallback] } },
			...extra,
		};
	}

	async function first(extra: Partial<Settings> = {}): Promise<Harness> {
		const harness = await createHarness({ models, fallbackNow: () => now, settings: settings(extra) });
		harnesses.push(harness);
		return harness;
	}

	async function sibling(of: Harness, extra: Partial<Settings> = {}, freshRuntime = false): Promise<Harness> {
		const harness = await createHarness({
			siblingOf: of,
			siblingFreshRuntime: freshRuntime,
			fallbackNow: () => now,
			settings: settings(extra),
		});
		harnesses.push(harness);
		return harness;
	}

	const calledModels = (harness: Harness) => harness.faux.getCallLog().map((call) => call.modelId);

	it("a sibling session skips an entry that failed out of the chain without sending it a request", async () => {
		const origin = await first();
		origin.setResponses([overloaded(), answer("fallback answer"), answer("sibling answer")]);

		await origin.session.prompt("first session burns the failing head");
		expect(calledModels(origin)).toEqual(["faux-1", "faux-2"]);

		const next = await sibling(origin);
		await next.session.prompt("sibling starts on the chain head");

		// given: the head failed out of the chain in another session sharing the runtime
		// then: the sibling's only request goes to the next entry
		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-2"]);
		expect(next.session.model?.id).toBe("faux-2");
		expect(next.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: primary, to: fallback }]);
	});

	it("shares circuits with a session on a fresh model runtime in the same agent dir, as after /new", async () => {
		const origin = await first();
		origin.setResponses([overloaded(), answer("fallback answer"), answer("new session answer")]);

		await origin.session.prompt("head fails out of the chain");
		const next = await sibling(origin, {}, true);
		await next.session.prompt("the CLI built a new runtime for this session");

		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-2"]);
	});

	it("a billing failure opens the circuit for sibling sessions", async () => {
		const origin = await first();
		origin.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "400 invalid_request_error: Your credit balance is too low to access the API.",
			}),
			answer("fallback answer"),
			answer("sibling answer"),
		]);

		await origin.session.prompt("head is out of credits");
		const next = await sibling(origin);
		await next.session.prompt("sibling");

		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-2"]);
	});

	it("a failed half-open probe re-opens the circuit with a doubled cooldown", async () => {
		const origin = await first();
		origin.setResponses([
			overloaded(),
			answer("fallback 1"),
			overloaded(),
			answer("fallback 2"),
			answer("still skipped"),
			answer("second probe"),
		]);

		await origin.session.prompt("open for 60s");
		now += 60_001;
		const prober = await sibling(origin);
		await prober.session.prompt("half-open probe fails");
		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-1", "faux-2"]);

		// when: the first cooldown has elapsed again, but the re-opened circuit waits 120s
		now += 60_001;
		const skipped = await sibling(origin);
		await skipped.session.prompt("still inside the doubled cooldown");
		expect(calledModels(origin).at(-1)).toBe("faux-2");

		now += 60_000;
		const nextProbe = await sibling(origin);
		await nextProbe.session.prompt("doubled cooldown elapsed");
		expect(calledModels(origin).at(-1)).toBe("faux-1");
	});

	it("keeps siblings off a half-open head while another session holds its single probe", async () => {
		const origin = await first();
		let waiting: Harness | undefined;
		origin.setResponses([
			overloaded(),
			answer("fallback answer"),
			async () => {
				// when: a second sibling starts while the probe request is in flight
				if (!waiting) throw new Error("waiting sibling missing");
				await waiting.session.prompt("probe is in flight");
				return answer("probe succeeded");
			},
			answer("waiting sibling answer"),
			answer("after the probe closed the circuit"),
		]);

		await origin.session.prompt("open");
		now += 60_001;
		const prober = await sibling(origin);
		waiting = await sibling(origin);
		await prober.session.prompt("claims the probe");

		// then: only the prober reached the head; the waiting sibling used the next entry
		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-1", "faux-2"]);
		expect(waiting.session.model?.id).toBe("faux-2");

		const after = await sibling(origin);
		await after.session.prompt("the probe succeeded");
		expect(calledModels(origin).at(-1)).toBe("faux-1");
	});

	it("still sends the request when every entry of the chain is open", async () => {
		const origin = await first();
		origin.setResponses([overloaded(), overloaded(), answer("probe answer")]);

		await origin.session.prompt("both entries fail out of the chain");
		expect(calledModels(origin)).toEqual(["faux-1", "faux-2"]);

		const next = await sibling(origin);
		await next.session.prompt("the chain must not refuse the turn");

		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-1"]);
		const last = next.session.messages.at(-1);
		expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("honours a provider Retry-After longer than the local cooldown", async () => {
		const origin = await first({ fallback: { circuitCooldownMs: 1_000 } });
		origin.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "HTTP 429: rate_limit_error (retry-after-ms: 600000)",
			}),
			answer("fallback answer"),
			answer("sibling answer"),
		]);

		await origin.session.prompt("rate limited for ten minutes");
		now += 5_000;
		const next = await sibling(origin, { fallback: { circuitCooldownMs: 1_000 } });
		await next.session.prompt("local cooldown elapsed, provider wait did not");

		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-2"]);
	});

	it("does not open a circuit for a refusal fallback", async () => {
		const refusalRetry = {
			retry: { enabled: true, baseDelayMs: 1, maxRetries: 1, fallbackChains: { [primary]: [fallback] } },
		};
		const origin = await first(refusalRetry);
		origin.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Stream ended with refusal",
				stopDetails: { type: "refusal" },
			}),
			answer("fallback answer"),
			answer("sibling answer"),
		]);

		await origin.session.prompt("refused");
		const next = await sibling(origin, refusalRetry);
		await next.session.prompt("sibling");

		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-1"]);
	});

	it("is disabled by fallback.circuitCooldownMs = 0", async () => {
		const disabled = { fallback: { circuitCooldownMs: 0 } };
		const origin = await first(disabled);
		origin.setResponses([overloaded(), answer("fallback answer"), answer("sibling answer")]);

		await origin.session.prompt("fails");
		const next = await sibling(origin, disabled);
		await next.session.prompt("sibling");

		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-1"]);
	});

	it("lets a manual model selection override an open circuit", async () => {
		const origin = await first();
		origin.setResponses([overloaded(), answer("fallback answer"), answer("manual answer")]);

		await origin.session.prompt("fails");
		const next = await sibling(origin);
		const head = next.getModel("faux-1");
		if (!head) throw new Error("missing faux-1");
		await next.session.setModel(head);
		await next.session.prompt("user picked the head explicitly");

		expect(calledModels(origin)).toEqual(["faux-1", "faux-2", "faux-1"]);
		expect(next.eventsOfType("retry_fallback_applied")).toHaveLength(0);
	});
});
