/**
 * The hand's hook advertisement of hosted model-key custody (row CK21; custody design 4.9, round-10 fold section 15).
 *
 * A hand tells a hosted brain, per bound session, which providers' calls need the device's hooks: the request hooks
 * (`before_provider_request`) and the stream hooks (`provider_stream_event`, `after_provider_response`) of the user's
 * extensions, each scoped by its `{ providers }` declaration or, undeclared, every provider (`"*"`). The advertisement
 * carries the `connectionId`, the session's `cwd` and its `advertHash`, and it is the first message for its session on
 * every (re)connect: the link serves no `hook.model_request` that its session's advertisement on that connection did
 * not precede.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@earendil-works/pi-agent-core";
import type { ProviderId } from "@earendil-works/pi-ai";
import type { HandSessionAdvertisement, HookModelRequest, HookModelRequestReply } from "../egress/wire.ts";
import type { Extension } from "../extensions/types.ts";

export type HookProviders = readonly ProviderId[] | "*";

export interface HandHookAccess {
	readonly requestHooks: HookProviders;
	readonly streamHooks: HookProviders;
}

const REQUEST_HOOK_EVENTS = ["before_provider_request"] as const;
const STREAM_HOOK_EVENTS = ["provider_stream_event", "after_provider_response"] as const;

function hookProviders(
	extensions: readonly Extension[],
	events: readonly string[],
	only: (extensionPath: string) => boolean,
): HookProviders {
	const declared = new Set<ProviderId>();
	for (const extension of extensions) {
		if (!only(extension.path)) continue;
		for (const event of events)
			for (const handler of extension.handlers.get(event) ?? []) {
				const providers = extension.handlerProviders?.get(handler);
				if (providers === undefined) return "*";
				for (const provider of providers) declared.add(provider);
			}
	}
	return [...declared].sort();
}

/** The request and stream hooks of the extensions `only` accepts (the ones that run on this hand). */
export function handHookAccess(
	extensions: readonly Extension[],
	only: (extensionPath: string) => boolean,
): HandHookAccess {
	return {
		requestHooks: hookProviders(extensions, REQUEST_HOOK_EVENTS, only),
		streamHooks: hookProviders(extensions, STREAM_HOOK_EVENTS, only),
	};
}

export interface AdvertHashParts {
	readonly extensionSetHash: string;
	readonly cwd: string;
	/** The project-local hook set, as hook identities; its order does not matter. */
	readonly projectHooks: readonly string[];
}

/** `H(extension set hash, cwd, project-local hook set)` (4.9): `sha256:` + hex SHA-256 of their canonical JSON. */
export function computeAdvertHash(parts: AdvertHashParts): string {
	const canonical = canonicalJson({
		cwd: parts.cwd,
		extensionSetHash: parts.extensionSetHash,
		projectHooks: [...parts.projectHooks].sort(),
	});
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** A bound session's advertisement, before a connection stamps it. */
export type HandHookSession = Omit<HandSessionAdvertisement, "t" | "connectionId">;

/** A hook request for a session not advertised on the connection it names; nothing ran. */
export class HookNotAdvertisedError extends Error {
	override readonly name = "HookNotAdvertisedError";
}

export interface HandHookLinkOptions {
	send(message: HandSessionAdvertisement | HookModelRequestReply): Promise<void>;
	serve(request: HookModelRequest): Promise<HookModelRequestReply>;
}

export interface HandHookLink {
	/** A new connection: every bound session's advertisement goes out first, in order, under `connectionId`. */
	connect(connectionId: string, sessions: readonly HandHookSession[]): Promise<void>;
	/** A session bound (or re-hashed) mid-connection: its advertisement goes out before anything else for it. */
	advertise(session: HandHookSession): Promise<void>;
	/**
	 * One `hook.model_request` received on `connectionId`; its reply follows that session's advertisement. Its hooks run
	 * outside the outgoing order, so a slow hook holds back no other request's reply and no advertisement.
	 */
	receive(connectionId: string, request: HookModelRequest): Promise<void>;
}

export function createHandHookLink(options: HandHookLinkOptions): HandHookLink {
	let connectionId: string | undefined;
	let advertised = new Set<string>();
	// One outgoing order: an advertisement queued before a reply is sent before it.
	let outgoing: Promise<void> = Promise.resolve();
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const run = outgoing.then(work);
		outgoing = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	const sendAdvert = (connection: string, session: HandHookSession, into: Set<string>) =>
		enqueue(async () => {
			if (connectionId !== connection) return;
			await options.send({ t: "hand.session.advertise", connectionId: connection, ...session });
			into.add(session.sessionId);
		});

	return {
		async connect(next, sessions) {
			connectionId = next;
			const fresh = new Set<string>();
			advertised = fresh;
			await Promise.all(sessions.map((session) => sendAdvert(next, session, fresh)));
		},
		async advertise(session) {
			if (connectionId === undefined) throw new HookNotAdvertisedError("no connection to advertise on");
			await sendAdvert(connectionId, session, advertised);
		},
		async receive(connection, request) {
			// Only the advertised check and the reply's send take a place in the outgoing order.
			await enqueue(async () => {
				if (connection !== connectionId || !advertised.has(request.sessionId))
					throw new HookNotAdvertisedError(
						`hook.model_request for session ${JSON.stringify(request.sessionId)} was not preceded by its advertisement on connection ${JSON.stringify(connection)}`,
					);
			});
			const reply = await options.serve(request);
			await enqueue(async () => {
				// A reconnect since the request arrived: its connection is gone, so its reply is not sent.
				if (connection !== connectionId) return;
				await options.send(reply);
			});
		},
	};
}
