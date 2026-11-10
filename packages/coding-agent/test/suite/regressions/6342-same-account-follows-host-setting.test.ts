import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { attach, type DelegatedHost, declare, type Peer } from "../rpc-delegated-host-support.ts";
import {
	ASKED,
	DEVICE,
	FrameLog,
	open,
	permissionHost,
	probeCalls,
	remotePeer,
} from "../rpc-delegated-permission-support.ts";

// senpi#6342: a turn follows the permission setting of the machine it runs on; a same-account origin never changes it,
// and no origin outlives the turn it started. A connection the forwarder did not state as same-account still asks.

const GRANT = ["observe", "drive", "thread", "answer"];
const RAN = { asked: [], ran: true };
const AGENT = { kind: "agent", session_id: "peer-session-a", name: "A" };

let armed = false;
const engineFollowUp: ExtensionFactory = (pi) => {
	pi.on("agent_end", () => {
		if (!armed) return;
		armed = false;
		pi.sendUserMessage("engine turn", { deliverAs: "followUp" });
	});
};

const engineCustomTurn: ExtensionFactory = (pi) => {
	pi.registerCommand("engine-turn", {
		description: "starts an engine custom-message turn",
		handler: async () => {
			pi.sendMessage({ customType: "engine-work", content: "engine work", display: true }, { triggerTurn: true });
		},
	});
};

let openGate: () => void = () => {};
let gateArmed: () => void = () => {};
const gatedTurn: ExtensionFactory = (pi) => {
	pi.registerCommand("gated-turn", {
		description: "starts an engine custom-message turn once the test opens its gate",
		handler: async () => {
			await new Promise<void>((resolve) => {
				openGate = resolve;
				gateArmed();
			});
			pi.sendMessage({ customType: "gated-work", content: "gated work", display: true }, { triggerTurn: true });
		},
	});
};

let runStarted: () => void = () => {};
const runStartSignal: ExtensionFactory = (pi) => {
	pi.on("agent_start", () => {
		const signal = runStarted;
		runStarted = () => {};
		signal();
	});
};

let customFollowUpArmed = false;
const engineCustomFollowUp: ExtensionFactory = (pi) => {
	pi.on("agent_end", () => {
		if (!customFollowUpArmed) return;
		customFollowUpArmed = false;
		pi.sendMessage(
			{ customType: "engine-follow-up", content: "engine work", display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
};

let host: DelegatedHost | undefined;
afterEach(async () => {
	armed = false;
	customFollowUpArmed = false;
	await host?.dispose();
	host = undefined;
}, 60_000);

async function sameAccountPeer(target: DelegatedHost, roles?: readonly string[]): Promise<Peer> {
	const peer = await target.proven();
	const declared = await declare(peer, GRANT, { ...DEVICE, sameAccount: true }, roles === undefined ? {} : { roles });
	if (declared.success !== true) throw new Error(`declare_delegation refused: ${JSON.stringify(declared)}`);
	return peer;
}

async function setup(connect: (target: DelegatedHost) => Promise<Peer>) {
	host = await permissionHost([engineFollowUp, engineCustomTurn, engineCustomFollowUp, gatedTurn, runStartSignal], {
		embedderPreset: true,
	});
	const local = await host.proven();
	const session = await open(local);
	const remote = await connect(host);
	expect(await remote.send(attach(session))).toMatchObject({ success: true });
	return { local, remote, id: session.sessionId };
}

const calls = (peer: Peer, id: string, count: number, start: () => Promise<unknown>) => {
	const log = new FrameLog(peer);
	return probeCalls(log, { log, peer }, id, { count, answer: "Deny", start });
};

const deliver = (peer: Peer, id: string, deliveryId: string, sender?: Record<string, unknown>) =>
	peer.send({
		type: "admit_external_message",
		sessionId: id,
		deliveryId,
		text: "read the probe",
		deliverAs: "followUp",
		whenIdle: "start",
		...(sender === undefined ? {} : { sender }),
	});

describe("a turn follows the receiving machine's own setting", () => {
	it("keeps no origin after a remote device's command: a later engine-started turn runs on the host setting", async () => {
		const { local, remote, id } = await setup(remotePeer);
		expect(await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			{ asked: ASKED, ran: false },
		]);
		armed = true;
		const [localCall, engineCall] = await calls(local, id, 2, () =>
			local.send({ type: "prompt", sessionId: id, message: "go" }),
		);
		expect(localCall).toEqual(RAN);
		expect(engineCall).toEqual(RAN);
	}, 120_000);

	it("keeps no origin after a peer-lane delivery: a later engine-started turn runs on the host setting", async () => {
		const { local, remote, id } = await setup(async (target) => {
			const peer = await target.proven();
			expect(await declare(peer, GRANT, DEVICE, { roles: ["peer_agent"] })).toMatchObject({ success: true });
			return peer;
		});
		expect(await calls(remote, id, 1, () => deliver(remote, id, "pa", AGENT))).toEqual([
			{ asked: ASKED, ran: false },
		]);
		armed = true;
		const [localCall, engineCall] = await calls(local, id, 2, () =>
			local.send({ type: "prompt", sessionId: id, message: "go" }),
		);
		expect(localCall).toEqual(RAN);
		expect(engineCall).toEqual(RAN);
	}, 120_000);

	it("keeps asking on the retried run of a cross-account device's prompt", async () => {
		const { remote, id } = await setup(remotePeer);
		host?.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" }, { id: "probe-retried" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		expect(await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			{ asked: ASKED, ran: false },
		]);
	}, 120_000);

	it("keeps asking for a run a cross-account device's slash command starts with no user message", async () => {
		const { remote, id } = await setup(remotePeer);
		expect(
			await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "/engine-turn" })),
		).toEqual([{ asked: ASKED, ran: false }]);
	}, 120_000);

	it("runs a later unmarked engine turn on the host setting after a cross-account prompt", async () => {
		const { remote, id } = await setup(remotePeer);
		customFollowUpArmed = true;
		expect(await calls(remote, id, 2, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			{ asked: ASKED, ran: false },
			RAN,
		]);
	}, 120_000);

	it.each([
		["a refused record from the same device", "remote"],
		["a local record", "local"],
	] as const)(
		"keeps asking for a cross-account slash command's run when %s arrives before it starts",
		async (_label, who) => {
			const { local, remote, id } = await setup(remotePeer);
			const armed = new Promise<void>((resolve) => {
				gateArmed = resolve;
			});
			expect(
				await calls(remote, id, 1, async () => {
					const sent = remote.send({ type: "prompt", sessionId: id, message: "/gated-turn" });
					await armed;
					await (who === "remote" ? remote : local).send({
						type: "set_thinking_level",
						sessionId: id,
						level: "low",
						scope: "turn",
					});
					openGate();
					await sent;
				}),
			).toEqual([{ asked: ASKED, ran: false }]);
		},
		120_000,
	);

	it("keeps asking for a cross-account custom message that joins a running local turn", async () => {
		const { local, remote, id } = await setup(remotePeer);
		const started = new Promise<void>((resolve) => {
			runStarted = resolve;
		});
		let custom: Promise<unknown> | undefined;
		const [localRun, joined] = await calls(local, id, 2, async () => {
			const sent = local.send({ type: "prompt", sessionId: id, message: "go" });
			await started;
			custom = remote.send({
				type: "send_custom_message",
				sessionId: id,
				customType: "remote-work",
				content: "remote work",
				display: true,
				triggerTurn: true,
				deliverAs: "followUp",
			});
			await sent;
		});
		await custom;
		expect(localRun).toEqual(RAN);
		expect(joined).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("never asks for a local slash command's run when a cross-account record arrives before it starts", async () => {
		const { local, remote, id } = await setup(remotePeer);
		const armed = new Promise<void>((resolve) => {
			gateArmed = resolve;
		});
		const [localRun] = await calls(local, id, 1, async () => {
			const sent = local.send({ type: "prompt", sessionId: id, message: "/gated-turn" });
			await armed;
			await remote.send({ type: "set_thinking_level", sessionId: id, level: "low", scope: "turn" });
			openGate();
			await sent;
		});
		expect(localRun).toEqual(RAN);
	}, 120_000);

	it("leaves no origin behind from a cross-account record that starts no run", async () => {
		const { local, remote, id } = await setup(remotePeer);
		const refused = await remote.send({ type: "set_thinking_level", sessionId: id, level: "low", scope: "turn" });
		expect(refused).toMatchObject({ success: false });
		expect(
			await calls(local, id, 1, () => local.send({ type: "prompt", sessionId: id, message: "/engine-turn" })),
		).toEqual([RAN]);
	}, 120_000);

	it("runs a same-account device's prompt on the host setting", async () => {
		const { remote, id } = await setup((target) => sameAccountPeer(target));
		expect(await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			RAN,
		]);
	}, 120_000);

	it("runs a same-account device's delivery on the host setting, whatever its sender", async () => {
		const { remote, id } = await setup((target) => sameAccountPeer(target));
		expect(await calls(remote, id, 1, () => deliver(remote, id, "s1", AGENT))).toEqual([RAN]);
		expect(await calls(remote, id, 1, () => deliver(remote, id, "s2"))).toEqual([RAN]);
	}, 120_000);

	it("still asks for a device the forwarder did not state as same-account, prompt and delivery alike", async () => {
		const { remote, id } = await setup(remotePeer);
		expect(await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			{ asked: ASKED, ran: false },
		]);
		expect(await calls(remote, id, 1, () => deliver(remote, id, "x1", AGENT))).toEqual([
			{ asked: ASKED, ran: false },
		]);
	}, 120_000);

	it("treats peer_agent as an admission fact only: a cross-account peer lane's agent delivery still asks", async () => {
		const { remote, id } = await setup(async (target) => {
			const peer = await target.proven();
			expect(await declare(peer, GRANT, DEVICE, { roles: ["peer_agent"] })).toMatchObject({ success: true });
			return peer;
		});
		expect(await calls(remote, id, 1, () => deliver(remote, id, "p1", AGENT))).toEqual([
			{ asked: ASKED, ran: false },
		]);
	}, 120_000);
});
