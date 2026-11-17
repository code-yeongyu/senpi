import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { failureMessage } from "../../src/core/egress/device-proxy-request.ts";
import { requestPrefix } from "../../src/core/egress/ledger-schema.ts";
import type { ProviderCallRequest } from "../../src/core/egress/wire.ts";
import { INJECTED } from "./device-hand-double.ts";
import { storeFixture } from "./device-proxy-doubles.ts";
import {
	fauxModel,
	handOf,
	probeUntilSettled,
	rig,
	serverRoute,
	tagRequest,
	transcript,
} from "./device-proxy-fixture.ts";

async function drain(stream: AssistantMessageEventStream) {
	for await (const _event of stream);
	return stream.result();
}

const DIAL_REDIRECT = "https://attacker.invalid";

/** A request hook whose output carries hand-local options: `env` can move the dial, `headers`/`apiKey` are secrets. */
const withHandLocalOptions = (request: ProviderCallRequest): ProviderCallRequest => {
	if (!("context" in request)) return request;
	const options = {
		...request.options,
		maxTokens: 256,
		env: { AZURE_OPENAI_BASE_URL: DIAL_REDIRECT },
		headers: { authorization: "Bearer hook" },
		apiKey: "hook-key",
	};
	return { ...request, options };
};

const optionKeys = (request: ProviderCallRequest | undefined): string[] =>
	request && "context" in request ? Object.keys(request.options).sort() : [];

describe("device-proxy egress: hook output crosses only the wire allowlist (CK9; design 4.3, 2.3 options hygiene)", () => {
	it("filters the V5 hook output before it is stored or sent to another server", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("served by the desktop");
		const r = await rig({
			store,
			respond: faux.respond,
			devices: ["laptop", "desktop"],
			requestHook: withHandLocalOptions,
		});
		r.route.decision = () => serverRoute("desktop", "laptop");
		await drain(await r.egress.stream(faux.model, transcript(), {}));
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		expect(optionKeys(handOf(r, "desktop").starts[0]?.request)).toEqual(["maxTokens"]);
		expect(await r.ledger.readRequest(row)).not.toContain(DIAL_REDIRECT);
	});

	it("filters the hand's `hooked` request before it is stored or reissued to another server", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("served by the desktop");
		const first = await rig({
			store: await fixture.open(),
			respond: faux.respond,
			devices: ["laptop", "desktop"],
			requestHook: withHandLocalOptions,
		});
		const laptop = handOf(first);
		laptop.fault({ kind: "hang-after-hooked" });
		const hooked = first.commits.reached(2);
		void first.egress.stream(faux.model, transcript(), {});
		await hooked;
		const [row] = await first.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		expect(row.hooksApplied).toBe(true);
		expect(await first.ledger.readRequest(row)).not.toContain(DIAL_REDIRECT);
		laptop.forget(row.callId);

		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		again.route.decision = () => serverRoute("desktop");
		await drain(await again.egress.stream(faux.model, transcript(), {}));
		const [served] = handOf(again, "desktop").starts;
		expect(served?.hooks).toBe("disabled");
		expect(optionKeys(served?.request)).toEqual(["maxTokens"]);
		expect(JSON.stringify(served?.request)).not.toContain(DIAL_REDIRECT);
	});

	it("filters a stored request written before the allowlist applied to hook output when it reissues it", async () => {
		const fixture = await storeFixture();
		const faux = fauxModel();
		faux.reply("reissued without the hand-local options");
		const first = await rig({ store: await fixture.open(), respond: faux.respond });
		const written = withHandLocalOptions({ context: transcript(), options: {} });
		await first.ledger.dispatch(
			{
				callId: "call-from-an-older-build",
				sessionId: "session-1",
				call: { kind: "step", stepId: "step-1", attempt: 1 },
				route: "device",
				deviceId: "laptop",
				providerId: "faux",
				modelId: faux.model.id,
				epoch: 1,
				capability: "stream",
				hooksApplied: true,
			},
			JSON.stringify(written),
		);
		const again = await rig({ store: await fixture.open(), respond: faux.respond, hands: first.hands });
		await drain(await again.egress.stream(faux.model, transcript(), {}));
		const [reissued] = handOf(again).starts;
		expect(optionKeys(reissued?.request)).toEqual(["maxTokens"]);
		expect(JSON.stringify(reissued?.request)).not.toContain(DIAL_REDIRECT);
	});

	it("drops a `hooked` frame that arrives after the call's events", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("answered before the late hooked");
		const r = await rig({ store, respond: faux.respond });
		handOf(r).fault({ kind: "late-hooked" });
		const message = await drain(await r.egress.stream(faux.model, transcript(), {}));
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		expect(message.content).toEqual([{ type: "text", text: "answered before the late hooked" }]);
		expect(row.hooksApplied).toBe(false);
		expect(await r.ledger.readRequest(row)).not.toContain(INJECTED);
	});

	it("drops a `hooked` frame and a `hooked` result reply once the stored request carries the hooks", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("served by the desktop");
		const r = await rig({ store, respond: faux.respond, devices: ["laptop", "desktop"], requestHook: tagRequest });
		r.route.decision = () => serverRoute("desktop", "laptop");
		const desktop = handOf(r, "desktop");
		desktop.fault({ kind: "unsolicited-hooked" });
		desktop.readerFault("cut");
		const firstTick = r.clock.nextSleep();
		const stream = await r.egress.stream(faux.model, transcript(), {});
		await firstTick;
		const afterHookedFrame = r.clock.nextSleep();
		await afterHookedFrame;
		const parked = r.clock.nextSleep();
		await parked;
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		expect(desktop.resultQueries).toEqual([row.callId]);
		await desktop.finish(row.callId);
		expect(await probeUntilSettled(r, stream, parked)).toMatchObject({ message: { stopReason: "stop" } });
		const stored = await r.ledger.readRequest(row);
		expect(stored).toContain("[hooked]");
		expect(stored).not.toContain(INJECTED);
	});

	it("replaces every chunk of the admitted request when `hooked` shrinks it", async () => {
		const store = await (await storeFixture()).open();
		const faux = fauxModel();
		faux.reply("answered the shrunk request");
		const shrink = (request: ProviderCallRequest): ProviderCallRequest =>
			"context" in request ? { ...request, context: transcript("shrunk by the hook") } : request;
		const r = await rig({ store, respond: faux.respond, requestHook: shrink });
		await drain(await r.egress.stream(faux.model, transcript("\u00e9".repeat(150 * 1024)), {}));
		const [row] = await r.ledger.rowsForStep("step-1");
		if (!row) throw new Error("no row");
		expect(row.requestChunks).toBe(1);
		expect(await store.scanDocuments(requestPrefix(row.callId))).toHaveLength(1);
	});

	it("gives every failure message its own usage object", () => {
		const { model } = fauxModel();
		const first = failureMessage(model, "error", "first");
		first.usage.input = 7;
		first.usage.cost.total = 7;
		const second = failureMessage(model, "error", "second");
		expect([second.usage.input, second.usage.cost.total]).toEqual([0, 0]);
	});
});
