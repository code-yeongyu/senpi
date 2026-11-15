/**
 * The RPC host's tool-relay mode (R3 `hand_link`, senpi#5924): a hosted brain reaches this machine through the relay,
 * and each packet batch arrives as one `hand_link` record. Every hosted session gets its own link
 * (`hand-link-session.ts`); this module decides which batch may reach which link.
 *
 * - The sender is the delegated connection's principal, never a frame field; it is the owner every epoch check sees.
 * - The state is durable and shared by every daemon under the agent dir (`hand-link-state.ts` over
 *   `locked-file-store.ts`). Each daemon claims it on its first batch and watches it: the moment a newer daemon claims
 *   it, this one ends every live link (aborting their running calls) and refuses every later batch
 *   `hand_link_host_superseded`, so only one daemon admits batches or runs calls at a time.
 * - A daemon reopens a session's link at the generation it already reached only when the daemon that opened it there
 *   ended it cleanly (a graceful shutdown releases its links); otherwise the brain must move to a higher generation, so
 *   a successor never runs a generation a predecessor's link may still be running.
 * - `loop.generation` is the session's owner epoch. A newer generation replaces the link and tears down the old one's
 *   scopes; an older one is refused, and so is a second sender or loop at the generation already admitted. A link that
 *   ended (a malformed batch, a held scope) reopens only at a higher generation. `close: true` retires the session.
 * - `instance`: a batch names the last link instance its brain saw. A batch with none opens the session's link at its
 *   generation only when this daemon has none open there; a batch naming one must name the open link. Anything else
 *   is `hand_link_instance_mismatch`, so a batch built for an earlier link never reaches a new one.
 * - A session holds at most a fixed number of scopes; a batch past it ends the link `hand_link_scope_limit`.
 * - One epoch fence for the whole host: a scope's floor is raised only by the owner of the session that first used
 *   that scope; a batch on a scope another session holds ends the link, and a loop-hook call naming one fails.
 * - A batch is answered at once with what the hand has queued, up to one record (`more` says more is queued); a tool
 *   still running answers in a later batch, so a following batch (an abort among them) never waits behind it.
 */
import type { HandWirePacket } from "../hand/hand-packet-codec.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { handLinkStatePath, type HandLinkState, openHandLinkState } from "./hand-link-state.ts";
import { openSessionLink, scopeLanes, type SessionLink } from "./hand-link-session.ts";
import { type LockedFileStore, openLockedFileStore } from "./locked-file-store.ts";
import { createLooplessHand, type LooplessHand } from "./remote-executor-scope.ts";

export interface HandLinkBatch {
	readonly session: string;
	readonly loop: { readonly id: string; readonly generation: number };
	/** The wire packets as the record carries them. */
	readonly packets: readonly unknown[];
	/** The last link instance the brain saw for this session; absent before it saw one. */
	readonly instance?: string;
	/** Retires the session: its link ends and every later batch is refused `hand_link_session_closed`. */
	readonly close?: true;
}

export type HandLinkRefusal =
	| "hand_link_malformed"
	| "hand_link_superseded"
	| "hand_link_generation_taken"
	| "hand_link_scope_taken"
	| "hand_link_scope_limit"
	| "hand_link_instance_mismatch"
	| "hand_link_session_closed"
	| "hand_link_host_superseded"
	| "hand_link_closed";

export type HandLinkAnswer =
	| {
			readonly kind: "packets";
			readonly packets: readonly HandWirePacket[];
			readonly more: boolean;
			readonly instance: string;
	  }
	| { readonly kind: "refused"; readonly reason: HandLinkRefusal };

export interface HandLinkEndpoint {
	link(sender: string, batch: HandLinkBatch): Promise<HandLinkAnswer>;
	close(): Promise<void>;
}

export interface HandLinkEndpointOptions {
	/** The machine's hand, opened on the first link; its scopes are shared by every session's link. */
	readonly openHand: () => Pick<LooplessHand, "openScope" | "loopHooks" | "close">;
	/** Opens the store the floors and link records persist in, on the first link; this daemon claims it. */
	readonly openStore: () => LockedFileStore;
	readonly report: (message: string) => void;
}

const refused = (reason: HandLinkRefusal): HandLinkAnswer => ({ kind: "refused", reason });

/** The store's refusal of a commit from an owner another daemon has superseded (`DurableStoreError` code). */
const isStaleEpoch = (error: unknown): boolean =>
	error instanceof Error && Reflect.get(error, "code") === "stale-epoch";

/** The RPC host's endpoint: the machine's hand on the host's own configuration, home of its loop hooks like `--hand`. */
export function createHostHandLink(configuration: CliRuntimeConfiguration): HandLinkEndpoint {
	return createHandLinkEndpoint({
		openHand: () => createLooplessHand(configuration, { twoSidedHome: "hand" }),
		openStore: () => openLockedFileStore(handLinkStatePath(configuration.agentDir)),
		report: (message) => void process.stderr.write(`senpi hand_link: ${message}\n`),
	});
}

export function createHandLinkEndpoint(options: HandLinkEndpointOptions): HandLinkEndpoint {
	const { report } = options;
	/** This daemon's claim on the store: stable for its life, so a retried claim is idempotent. */
	const token = crypto.randomUUID();
	const links = new Map<string, SessionLink>();
	const queues = new Map<string, Promise<unknown>>();
	let hand: ReturnType<HandLinkEndpointOptions["openHand"]> | undefined;
	let opening: Promise<HandLinkState> | undefined;
	let closed = false;

	// Opened on the first batch, so a host that never serves one touches no state; a failed open is tried again.
	const stateOf = (): Promise<HandLinkState> => {
		opening ??= openHandLinkState(options.openStore(), token).then(
			(state) => {
				state.onSuperseded(() => void endAll());
				return state;
			},
			(error: unknown) => {
				opening = undefined;
				throw error;
			},
		);
		return opening;
	};
	const end = async (session: string): Promise<void> => {
		const link = links.get(session);
		if (link === undefined) return;
		links.delete(session);
		await link.close();
	};
	const endAll = (): Promise<unknown> => Promise.allSettled([...links.keys()].map((session) => end(session)));
	const refuseAndEnd = async (
		state: HandLinkState,
		batch: HandLinkBatch,
		reason: HandLinkRefusal,
	): Promise<HandLinkAnswer> => {
		await state.end(batch.session, batch.loop.generation + 1);
		await end(batch.session);
		return refused(reason);
	};

	const linkFor = async (
		state: HandLinkState,
		sender: string,
		batch: HandLinkBatch,
	): Promise<SessionLink | HandLinkAnswer> => {
		const { session, loop } = batch;
		const record = state.session(session);
		if (record?.closed === true) return refused("hand_link_session_closed");
		if (loop.generation < (record?.lowest ?? 1)) return refused("hand_link_superseded");
		const holder = record?.lowest === loop.generation ? record.holder : undefined;
		if (holder !== undefined && (holder.owner !== sender || holder.loopId !== loop.id))
			return refused("hand_link_generation_taken");
		// Another daemon's link at this generation may still be running: only a clean end lets it reopen here.
		if (holder !== undefined && holder.daemon !== token && holder.ended !== true && !links.has(session))
			return refused("hand_link_instance_mismatch");
		const current = links.get(session);
		if (current?.generation === loop.generation)
			return batch.instance === current.instance ? current : refused("hand_link_instance_mismatch");
		if (batch.instance !== undefined) return refused("hand_link_instance_mismatch");
		// A newer generation, or the session's first batch since this daemon started, opens its link: an older link's
		// running calls are aborted and its scopes disposed.
		await end(session);
		await state.admit(session, loop.generation, { owner: sender, loopId: loop.id });
		hand ??= options.openHand();
		const link = openSessionLink({
			hand,
			fence: state.fence,
			claimScope: (scope) => state.claim(scope, session),
			sender,
			generation: loop.generation,
			report,
		});
		links.set(session, link);
		return link;
	};

	const admit = async (state: HandLinkState, sender: string, batch: HandLinkBatch): Promise<HandLinkAnswer> => {
		const link = await linkFor(state, sender, batch);
		if (!("deliver" in link)) return link;
		if (batch.close === true) {
			await end(batch.session);
			await state.retire(batch.session);
			return { kind: "packets", packets: [], more: false, instance: link.instance };
		}
		const packets = link.read(batch.packets);
		if (packets === undefined) return refuseAndEnd(state, batch, "hand_link_malformed");
		for (const scope of scopeLanes(packets)) {
			const claim = await state.claim(scope, batch.session);
			if (claim === "taken") return refuseAndEnd(state, batch, "hand_link_scope_taken");
			if (claim === "limit") return refuseAndEnd(state, batch, "hand_link_scope_limit");
		}
		link.deliver(packets);
		// One turn of the event loop lets the frames this batch delivered be acknowledged and answered now; a call
		// still running answers in a later batch.
		await new Promise<void>((resolve) => setImmediate(resolve));
		return { kind: "packets", ...link.answer(), instance: link.instance };
	};

	const handle = async (sender: string, batch: HandLinkBatch): Promise<HandLinkAnswer> => {
		if (closed) return refused("hand_link_closed");
		const state = await stateOf();
		const superseded = async (): Promise<HandLinkAnswer> => {
			await endAll();
			return refused("hand_link_host_superseded");
		};
		if (!state.owned()) return superseded();
		try {
			return await admit(state, sender, batch);
		} catch (error) {
			// A newer daemon claimed the store between the ownership check and this batch's commit.
			if (isStaleEpoch(error)) return superseded();
			throw error;
		}
	};

	return {
		link(sender, batch) {
			const previous = queues.get(batch.session) ?? Promise.resolve();
			const next = previous.then(() => handle(sender, batch));
			const settled = next.catch(() => undefined);
			queues.set(batch.session, settled);
			void settled.then(() => {
				if (queues.get(batch.session) === settled) queues.delete(batch.session);
			});
			return next;
		},
		async close() {
			closed = true;
			const state = await opening?.catch(() => undefined);
			// A graceful shutdown ends its links cleanly, so a successor may reopen them at the same generation.
			if (state?.owned() === true)
				await state
					.release([...links.keys()])
					.catch((error: unknown) => report(`release failed: ${String(error)}`));
			await endAll();
			state?.close();
			await hand?.close();
		},
	};
}
