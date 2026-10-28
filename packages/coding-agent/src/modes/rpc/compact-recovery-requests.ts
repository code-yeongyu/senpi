import type { RecoveryPage } from "./compact-recovery-bytes.ts";
import { type CursorBinding, RecoveryCursors } from "./compact-recovery-cursor.ts";
import { parseBoundedId } from "./compact-recovery-ids.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import type { CheckpointToken, RecoveryCaller, RecoveryFailure, RecoveryOutcome } from "./compact-recovery-types.ts";
import { repairNeeded } from "./compact-recovery-types.ts";

/** At most this many page requests are outstanding on one socket across all of its tokens (R4.B3). */
const SOCKET_PAGE_REQUESTS_MAX = 8;

/** B3's request fields: every one an opaque bounded id, parsed before any use. */
export interface RecoveryPageRequest {
	readonly requestId: string;
	readonly admissionId: string;
	readonly token: string;
	readonly componentRef: string;
	readonly cursor?: string;
}

/**
 * One page as the wire carries it (B3, RULING-69 (1)): `bytes` is the base64 of exactly `length` raw stored bytes at
 * `offset`; `digest` is over those raw bytes, so a client verifies it after decoding. `cursor` continues the component
 * or is null once `complete`.
 */
export interface RecoveryPageAnswer {
	readonly requestId: string;
	readonly token: string;
	readonly generation: number;
	readonly componentRef: string;
	readonly ordinal: number;
	readonly offset: number;
	readonly length: number;
	readonly digest: string;
	readonly bytes: string;
	readonly cursor: string | null;
	readonly complete: boolean;
}

export type RequestRefusalReason =
	| "malformed_request"
	| "busy"
	| "request_limit"
	| "request_mismatch"
	| "invalid_cursor"
	| "cursor_out_of_range"
	| "ordinal_exhausted";

/** What the client does next: wait for the current request, start the component over, re-admit, or send a new id. */
export type RequestRefusalHint = "retry" | "restart_from_catalog" | "release_token" | "new_request";

export interface RequestRefusal {
	readonly kind: "request_refused";
	readonly reason: RequestRefusalReason;
	readonly hint: RequestRefusalHint;
}

export type RecoveryPageFailure = RecoveryFailure | RequestRefusal;

export type RecoveryPageOutcome =
	| { readonly ok: true; readonly value: RecoveryPageAnswer }
	| { readonly ok: false; readonly failure: RecoveryPageFailure };

export interface RecoveryPageCounters {
	readonly tokens: number;
	readonly outstanding: number;
	readonly cachedBytes: number;
	readonly refused: Readonly<Partial<Record<RequestRefusalReason, number>>>;
}

/** One token's request state: its last ordinal, whether a request is in flight, and the one page kept for a retry. */
interface TokenRequests {
	active: boolean;
	ordinal: number;
	current: { readonly request: RecoveryPageRequest; readonly answer: RecoveryPageAnswer } | undefined;
}

const HINTS: Readonly<Record<RequestRefusalReason, RequestRefusalHint>> = {
	malformed_request: "new_request",
	busy: "retry",
	request_limit: "retry",
	request_mismatch: "new_request",
	invalid_cursor: "restart_from_catalog",
	cursor_out_of_range: "restart_from_catalog",
	ordinal_exhausted: "release_token",
};

const sameRequest = (a: RecoveryPageRequest, b: RecoveryPageRequest): boolean =>
	a.requestId === b.requestId && a.componentRef === b.componentRef && a.cursor === b.cursor && a.token === b.token;

/**
 * The page requests of one host over its checkpoint owner (S11b, RULING-62 Q1 A): one monotonically advancing ordinal
 * per token, one active request per token (a second concurrent one is `busy`, taking no slot and no memory), at most
 * `SOCKET_PAGE_REQUESTS_MAX` outstanding per socket, and one cached page per token so an exact retry answers identical
 * bytes without a read; the cache goes when the next request advances or the token ends. Every refusal is typed and
 * happens before any byte is read.
 */
export class RecoveryPageRequests {
	private readonly checkpoints: RecoveryCheckpoints;
	private readonly cursors: RecoveryCursors;
	private readonly tokens = new Map<string, TokenRequests>();
	private readonly outstanding = new Map<string, number>();
	private readonly refusals = new Map<RequestRefusalReason, number>();
	/** Per socket with a request in flight: its connection's lifetime, aborted when that peer's connection ends. */
	private readonly lifetimes = new Map<string, AbortController>();

	constructor(checkpoints: RecoveryCheckpoints, cursors = new RecoveryCursors()) {
		this.checkpoints = checkpoints;
		this.cursors = cursors;
		checkpoints.onTokenEnd((tokenId) => this.tokens.delete(tokenId));
	}

	status(): RecoveryPageCounters {
		let outstanding = 0;
		for (const count of this.outstanding.values()) outstanding += count;
		let cachedBytes = 0;
		for (const { current } of this.tokens.values()) cachedBytes += current?.answer.bytes.length ?? 0;
		return { tokens: this.tokens.size, outstanding, cachedBytes, refused: Object.fromEntries(this.refusals) };
	}

	/**
	 * A peer incarnation's connection ended (closed, errored or cut): every open still verifying for it stops, typed
	 * `aborted`, so its slots and its tokens are freed at the next leaf instead of when the verification ends.
	 */
	forgetPeer(socketEpoch: string): void {
		this.lifetimes.get(socketEpoch)?.abort();
		this.lifetimes.delete(socketEpoch);
	}

	/**
	 * `signal` is the request's budget: a first open's verification is charged to it and to the asking connection's
	 * lifetime, whichever ends first (RULING-69 (2)).
	 */
	async request(
		caller: RecoveryCaller,
		request: RecoveryPageRequest,
		signal?: AbortSignal,
	): Promise<RecoveryPageOutcome> {
		const fields = [request.requestId, request.admissionId, request.token, request.componentRef];
		if (fields.some((field) => typeof field !== "string" || !parseBoundedId(field).ok))
			return this.refuse("malformed_request");
		if ((this.outstanding.get(caller.socketEpoch) ?? 0) >= SOCKET_PAGE_REQUESTS_MAX)
			return this.refuse("request_limit");
		const token = this.checkpoints
			.tokens()
			.find(
				(candidate) => candidate.id === request.token && candidate.admission.admissionId === request.admissionId,
			);
		if (
			!token ||
			token.admission.socketEpoch !== caller.socketEpoch ||
			token.admission.sessionId !== caller.sessionId
		)
			return { ok: false, failure: repairNeeded("unknown_token") };
		const claimed = this.checkpoints.check(token, caller);
		if (!claimed.ok) return claimed;
		const state = this.tokens.get(token.id) ?? { active: false, ordinal: 0, current: undefined };
		if (state.active) return this.refuse("busy");
		if (state.current?.request.requestId === request.requestId)
			return sameRequest(state.current.request, request)
				? { ok: true, value: state.current.answer }
				: this.refuse("request_mismatch");
		const binding: CursorBinding = {
			socketEpoch: caller.socketEpoch,
			sessionId: caller.sessionId,
			tokenId: token.id,
			generation: token.admission.generation,
			componentRef: request.componentRef,
		};
		const position = request.cursor === undefined ? undefined : this.cursors.open(request.cursor, binding);
		if (request.cursor !== undefined && position === undefined) return this.refuse("invalid_cursor");
		const last = position?.ordinal ?? state.ordinal;
		if (!Number.isSafeInteger(last + 1)) return this.refuse("ordinal_exhausted");
		if (position !== undefined && position.ordinal !== state.ordinal) return this.refuse("cursor_out_of_range");
		this.tokens.set(token.id, state);
		return this.serve(caller, token, request, state, binding, position?.offset ?? 0, signal);
	}

	/** Holds the token's active flag and one socket slot from before the read until the outcome is known. */
	private async serve(
		caller: RecoveryCaller,
		token: CheckpointToken,
		request: RecoveryPageRequest,
		state: TokenRequests,
		binding: CursorBinding,
		offset: number,
		signal: AbortSignal | undefined,
	): Promise<RecoveryPageOutcome> {
		state.active = true;
		this.outstanding.set(caller.socketEpoch, (this.outstanding.get(caller.socketEpoch) ?? 0) + 1);
		const lifetime = this.lifetimes.get(caller.socketEpoch) ?? new AbortController();
		this.lifetimes.set(caller.socketEpoch, lifetime);
		const budget = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
		let page: RecoveryOutcome<RecoveryPage>;
		try {
			page = await this.checkpoints.readCatalogPage(token, caller, request.componentRef, offset, budget);
		} finally {
			state.active = false;
			const left = (this.outstanding.get(caller.socketEpoch) ?? 1) - 1;
			if (left > 0) this.outstanding.set(caller.socketEpoch, left);
			else {
				this.outstanding.delete(caller.socketEpoch);
				if (this.lifetimes.get(caller.socketEpoch) === lifetime) this.lifetimes.delete(caller.socketEpoch);
			}
		}
		if (!page.ok) return page;
		if (!this.tokens.has(token.id)) return { ok: false, failure: repairNeeded("released") };
		const ordinal = state.ordinal + 1;
		const answer: RecoveryPageAnswer = {
			requestId: request.requestId,
			token: token.id,
			generation: token.admission.generation,
			componentRef: request.componentRef,
			ordinal,
			offset: page.value.offset,
			length: page.value.length,
			digest: page.value.digest,
			bytes: page.value.bytes.toString("base64"),
			cursor: page.value.next === null ? null : this.cursors.mint(binding, { ordinal, offset: page.value.next }),
			complete: page.value.complete,
		};
		state.ordinal = ordinal;
		state.current = { request, answer };
		return { ok: true, value: answer };
	}

	private refuse(reason: RequestRefusalReason): RecoveryPageOutcome {
		this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
		return { ok: false, failure: { kind: "request_refused", reason, hint: HINTS[reason] } };
	}
}
