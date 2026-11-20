// senpi#7098 follow-up (delta review of #7105, M1). Discovery was bounded, but every other call a successor makes to
// its predecessor still waited for an answer with no limit: the attach of a routed open, the two declarations that set
// up a route connection, a narrowing declaration copied upstream, and a routed command. A predecessor that stalls yet
// keeps its socket open therefore left a routed open_session, a sessionless set_client_info / declare_delegation reply
// and a routed command without an answer forever. Each now answers within the bound: a late answer is followed by a
// liveness probe, and a predecessor that answers neither is refused as predecessor_request_timeout.
import { afterEach, expect, it, vi } from "vitest";
import { CommandAuthority, commandAuthority } from "../../../src/modes/rpc/command-authority.ts";
import { INTERACTIVE_USER_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { PREDECESSOR_REQUEST_TIMEOUT_MS } from "../../../src/modes/rpc/predecessor-peer.ts";
import {
	advanceUntil,
	answer,
	type Cleanups,
	fakePredecessor,
	type PredecessorHandlers,
	successorWithPredecessorClaim,
	type WireRecord,
} from "../rpc-predecessor-route-support.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TIMEOUT = { success: false, error: "predecessor_request_timeout" };
const listsNothing: PredecessorHandlers = {
	list_sessions: (stream, request) => answer(stream, request, { sessions: [] }),
};
const attaches: PredecessorHandlers = {
	...listsNothing,
	open_session: (stream, request) => answer(stream, request, { sessionId: "upstream-1" }),
};

/** A successor whose predecessor holds `held.jsonl`; `asked` resolves once the predecessor received `stalls`. */
async function successorAsking(stalls: string, handlers: PredecessorHandlers) {
	const host = await successorWithPredecessorClaim(cleanups);
	await host.predecessorHolds();
	const asked = Promise.withResolvers<void>();
	await fakePredecessor(cleanups, host, { ...handlers, [stalls]: () => asked.resolve() });
	return { host, asked: asked.promise };
}

function routedOpen(host: Awaited<ReturnType<typeof successorWithPredecessorClaim>>) {
	return host.send({ type: "open_session", id: "routed", sessionPath: host.heldPath });
}

async function routedSessionId(host: Awaited<ReturnType<typeof successorWithPredecessorClaim>>): Promise<string> {
	const opened = await routedOpen(host);
	expect(opened, JSON.stringify(opened)).toMatchObject({ success: true });
	return (opened as { data: { sessionId: string } }).data.sessionId;
}

async function answersWithinBound(reply: Promise<unknown>, asked: Promise<void>): Promise<void> {
	await asked;
	expect(await advanceUntil(reply, PREDECESSOR_REQUEST_TIMEOUT_MS, 20), "the predecessor call never ended").toBe(true);
}

it.skipIf(process.platform === "win32")("a routed open_session whose attach goes unanswered answers", async () => {
	const { host, asked } = await successorAsking("open_session", listsNothing);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

	const reply = routedOpen(host);

	await answersWithinBound(reply, asked);
	expect(await reply).toMatchObject(TIMEOUT);
});

it.skipIf(process.platform === "win32")(
	"a routed open_session whose delegation declaration goes unanswered answers",
	async () => {
		const { host, asked } = await successorAsking("declare_delegation", attaches);
		expect(
			host.writer.delegations.inspect("client", {
				type: "declare_delegation",
				principal: { deviceId: "d7098" },
				granted: ["observe", "drive"],
			}),
		).toMatchObject({ kind: "reply", response: { success: true } });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const reply = commandAuthority.run(
			new CommandAuthority("client", host.writer.delegations.descriptorOf("client"), undefined),
			() => routedOpen(host),
		);

		await answersWithinBound(reply, asked);
		expect(await reply).toMatchObject(TIMEOUT);
	},
);

it.skipIf(process.platform === "win32")(
	"a routed open_session whose client declaration goes unanswered answers",
	async () => {
		const { host, asked } = await successorAsking("set_client_info", attaches);
		expect(
			await host.send({
				type: "set_client_info",
				id: "roles",
				width: 80,
				capabilities: [INTERACTIVE_USER_CAPABILITY],
			}),
		).toMatchObject({ success: true });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const reply = routedOpen(host);

		await answersWithinBound(reply, asked);
		expect(await reply).toMatchObject(TIMEOUT);
	},
);

it.skipIf(process.platform === "win32")(
	"a narrowing declaration copied to an unanswering predecessor is still acknowledged",
	async () => {
		const { host, asked } = await successorAsking("set_client_info", attaches);
		await routedSessionId(host);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const configured = host.router.configureRoutes("client", { type: "set_client_info", capabilities: [] });

		await answersWithinBound(configured, asked);
		await expect(configured).resolves.toBeUndefined();
	},
);

it.skipIf(process.platform === "win32")("a routed command the predecessor never answers is refused", async () => {
	const { host, asked } = await successorAsking("prompt", attaches);
	const sessionId = await routedSessionId(host);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

	const reply = host.send({ type: "prompt", id: "stalled", sessionId, message: "held upstream" });

	await answersWithinBound(reply, asked);
	expect(await reply).toMatchObject(TIMEOUT);
});

it.skipIf(process.platform === "win32")(
	"a written mutation whose probe meets a connection another deadline just cut is never replayed",
	async () => {
		const received: string[] = [];
		const both = Promise.withResolvers<void>();
		const host = await successorWithPredecessorClaim(cleanups);
		await host.predecessorHolds();
		const first = Promise.withResolvers<void>();
		await fakePredecessor(cleanups, host, {
			...attaches,
			prompt: (_stream, request) => {
				received.push(String(request.message));
				if (received.length === 1) first.resolve();
				else both.resolve();
			},
		});
		const sessionId = await routedSessionId(host);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		// A's answer bound passes and its probe goes out; B is written while that probe is pending, so A's probe
		// deadline (which cuts the connection) and B's own bound expire in the same timers phase.
		const a = host.send({ type: "prompt", id: "a", sessionId, message: "a" });
		await first.promise;
		vi.advanceTimersByTime(PREDECESSOR_REQUEST_TIMEOUT_MS);
		const b = host.send({ type: "prompt", id: "b", sessionId, message: "b" });
		await both.promise;
		vi.advanceTimersByTime(PREDECESSOR_REQUEST_TIMEOUT_MS);

		expect(await advanceUntil(Promise.all([a, b]), PREDECESSOR_REQUEST_TIMEOUT_MS / 50, 400)).toBe(true);
		expect(received).toEqual(["a", "b"]);
		const answeredB = await b;
		expect(answeredB, JSON.stringify(answeredB)).toMatchObject({
			success: false,
			error: "predecessor_delivery_outcome_unknown",
		});
		expect(await a).toMatchObject(TIMEOUT);
		expect(host.registry.peek(sessionId)).toBeUndefined();
	},
);

it.skipIf(process.platform === "win32")(
	"a long routed command keeps waiting while the predecessor answers its liveness probes",
	async () => {
		const held = Promise.withResolvers<() => void>();
		const host = await successorWithPredecessorClaim(cleanups);
		await host.predecessorHolds();
		await fakePredecessor(cleanups, host, {
			...attaches,
			get_protocol_info: (stream, request) => answer(stream, request, { instanceId: "pred", generation: 0 }),
			prompt: (stream, request: WireRecord) => held.resolve(() => answer(stream, request, {})),
		});
		const sessionId = await routedSessionId(host);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const reply = host.send({ type: "prompt", id: "long", sessionId, message: "runs a while" });
		const finish = await held.promise;

		// Six bounds of virtual time in small steps: each probe's answer crosses the socket between two steps.
		expect(
			await advanceUntil(reply, PREDECESSOR_REQUEST_TIMEOUT_MS / 50, 300),
			"a live predecessor's command was cut",
		).toBe(false);
		finish();
		expect(await advanceUntil(reply, PREDECESSOR_REQUEST_TIMEOUT_MS / 50, 100)).toBe(true);
		const answered = await reply;
		expect(answered, JSON.stringify(answered)).toMatchObject({ success: true });
	},
);
