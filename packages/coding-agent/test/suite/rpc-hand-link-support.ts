/**
 * R3 `hand_link` fixture: the delegated-connection host (`rpc-delegated-host-support.ts`) serving this machine's hand
 * through `createHandLinkEndpoint`, and a hosted brain (agent-core `createRemoteToolHost`, cross-machine, its loop
 * generation as its epoch) whose packets travel as `hand_link` records on a delegated connection, as the relay carries
 * them. The brain pulls: every round trip sends what it has queued (an empty batch is a poll) and feeds the answer.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
	createReliableTransport,
	createRemoteToolHost,
	type ToolHostResult,
	type TransportSide,
} from "@earendil-works/pi-agent-core";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { InlineExtension } from "../../src/core/extensions/types.ts";
import { createHandPacketReader, encodeHandPackets } from "../../src/modes/hand/hand-packet-codec.ts";
import { createHandLinkEndpoint } from "../../src/modes/rpc/hand-link-endpoint.ts";
import { handLinkStatePath } from "../../src/modes/rpc/hand-link-state.ts";
import { openLockedFileStore } from "../../src/modes/rpc/locked-file-store.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { declare, type HandLinkFactory, type Peer, startHost, type WireRecord } from "./rpc-delegated-host-support.ts";

export const BRAIN_A = { deviceId: "hb-brain-a" };
export const BRAIN_B = { deviceId: "hb-brain-b" };

/** The tool probes: `count` marks count.txt, `echo` returns its text, `wait_abort` holds until its call is aborted. */
export interface HandProbe {
	readonly started: PromiseWithResolvers<void>;
	/** Settles when a `wait_abort` call has seen its abort. */
	readonly abortSeen: PromiseWithResolvers<void>;
	aborted: boolean;
	/** When set, a `wait_abort` call keeps running after its abort until this settles. */
	hold?: PromiseWithResolvers<void>;
}

export function handProbe(): HandProbe {
	return { started: Promise.withResolvers<void>(), abortSeen: Promise.withResolvers<void>(), aborted: false };
}

export function probeTools(probe: HandProbe): InlineExtension {
	return (pi) => {
		pi.registerTool({
			name: "count",
			label: "Count",
			description: "Appends one mark to count.txt in its cwd.",
			parameters: { type: "object", properties: {} },
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				appendFileSync(join(ctx.cwd, "count.txt"), "x");
				return { content: [{ type: "text", text: `counted in ${ctx.cwd}` }], details: {} };
			},
		});
		pi.registerTool({
			name: "echo",
			label: "Echo",
			description: "Returns its text.",
			parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			async execute(_id, params) {
				return { content: [{ type: "text", text: String((params as { text: unknown }).text) }], details: {} };
			},
		});
		pi.registerTool({
			name: "wait_abort",
			label: "Wait for abort",
			description: "Runs until its call is aborted.",
			parameters: { type: "object", properties: {} },
			async execute(_id, _params, signal) {
				probe.started.resolve();
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				probe.aborted = true;
				probe.abortSeen.resolve();
				await probe.hold?.promise;
				return { content: [{ type: "text", text: "aborted" }], details: {} };
			},
		});
	};
}

export async function handLinkHost(probe: HandProbe = handProbe()) {
	return startHost({ handLink: handLinkOn(probe) });
}

export function handLinkOn(probe: HandProbe): HandLinkFactory {
	return (configuration) =>
		createHandLinkEndpoint({
			openHand: () =>
				createLooplessHand(configuration, { twoSidedHome: "hand", extensionFactories: [probeTools(probe)] }),
			openStore: () => openLockedFileStore(handLinkStatePath(configuration.agentDir)),
			report: (message) => {
				throw new Error(`hand_link report: ${message}`);
			},
		});
}

export async function brainPeer(
	host: Awaited<ReturnType<typeof handLinkHost>>,
	principal: object,
	granted: readonly string[] = ["hand_link"],
): Promise<Peer> {
	const peer = await host.proven();
	const declared = await declare(peer, granted, principal);
	if (declared.success !== true) throw new Error(`declare_delegation refused: ${JSON.stringify(declared)}`);
	return peer;
}

export interface Brain {
	readonly session: string;
	readonly loop: { readonly id: string; readonly generation: number };
	readonly scope: string;
	readonly side: TransportSide;
	readonly host: ReturnType<typeof createRemoteToolHost>;
	readonly outgoing: unknown[];
	readonly read: ReturnType<typeof createHandPacketReader>;
	/** The last link instance an answer named: sent on every later batch, as a brain must (a fresh brain has none). */
	readonly link: { instance?: string };
}

export function brain(
	session: string,
	generation: number,
	options: { readonly loopId?: string; readonly scope?: string } = {},
): Brain {
	const outgoing: unknown[] = [];
	const side = createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
	side.attached({
		send: (message) => {
			outgoing.push(message);
			return true;
		},
		close: () => {},
	});
	const host = createRemoteToolHost({ transport: side, placement: "cross-machine", epoch: generation });
	return {
		session,
		loop: { id: options.loopId ?? `loop-${generation}`, generation },
		scope: options.scope ?? `scope-${session}`,
		side,
		host,
		outgoing,
		read: createHandPacketReader(),
		link: {},
	};
}

/** One `hand_link` record carrying everything the brain queued; the answer's packets are fed to the brain. */
export async function batch(peer: Peer, from: Brain): Promise<WireRecord> {
	const packets = from.outgoing.splice(0).flatMap((message) => encodeHandPackets(message) ?? []);
	const { instance } = from.link;
	const answer = await peer.send({
		type: "hand_link",
		session: from.session,
		loop: from.loop,
		packets,
		...(instance === undefined ? {} : { instance }),
	});
	if (answer.success !== true) return answer;
	from.link.instance = (answer.data as { instance: string }).instance;
	for (const wire of (answer.data as { packets: unknown[] }).packets) {
		const packet = from.read(wire);
		if (packet === undefined) throw new Error(`the hand sent a malformed packet: ${JSON.stringify(wire)}`);
		if (packet !== null) from.side.message(packet);
	}
	return answer;
}

/** Round trips until the hand refuses a batch; its refusal. */
export async function untilRefused(peer: Peer, from: Brain): Promise<WireRecord> {
	for (;;) {
		const answer = await batch(peer, from);
		if (answer.success !== true) return answer;
	}
}

/** Round trips until `until` settles (the brain must pull: late output only arrives on a batch's answer). */
export async function pump<T>(peer: Peer, from: Brain, until: Promise<T>): Promise<T> {
	let settled = false;
	const done = until.finally(() => {
		settled = true;
	});
	while (!settled) {
		const answer = await batch(peer, from);
		if (answer.success !== true) throw new Error(`hand_link refused: ${JSON.stringify(answer)}`);
	}
	return done;
}

export function call(from: Brain, root: string, name: string, args: JsonObject, signal?: AbortSignal) {
	return from.host.execute(
		{
			scope: { id: from.scope, root },
			calls: [{ type: "toolCall", id: `${name}-1`, name, arguments: args }],
			mode: "parallel",
		},
		{ emit: () => {}, ...(signal === undefined ? {} : { signal }) },
	);
}

export function resultText(result: ToolHostResult): string {
	return result.messages
		.flatMap((message) => message.content.map((part) => (part.type === "text" ? part.text : "")))
		.join("");
}
