import { afterEach, expect, it, vi } from "vitest";
import { FRAGMENT_ENVELOPE_MAX_BYTES, FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { CompactRecoveryCatalog } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import { RecoveryCursors } from "../../../src/modes/rpc/compact-recovery-cursor.ts";
import {
	type RecoveryPageAnswer,
	type RecoveryPageOutcome,
	type RecoveryPageRequest,
	RecoveryPageRequests,
} from "../../../src/modes/rpc/compact-recovery-requests.ts";
import { RecoveryCheckpoints, type RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryCaller } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S11b, R4.B3, X04/T5, RULING-62 Q1 A + (1)(2)(3), Q2 (1)(3)(4), RULING-69 slow-open rule): the page
// request owner over the checkpoint owner. One monotonically advancing ordinal per token; one active request per
// token (a second concurrent one is a typed busy with a retry hint, no slot, no memory); an exact retry of the current
// request returns identical bytes from the one cached page, which is freed on advance or release; changed parameters
// under one request id are refused; at most eight requests outstanding per socket; the cursor's ordinal is re-checked
// against the token's own; ordinals never pass the 53-bit bound.

afterEach(() => {
	vi.restoreAllMocks();
});

const route = (sessionId: string, socketEpoch = "socket-1"): RecoveryRoute => ({
	socketEpoch,
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId,
});

function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; failure: unknown }): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

/** A session id of 300,003 code units (600,006 stored bytes): five pages, the last one partial. */
const huge = `${"\u{1F600}세션/..\\".repeat(37_500)}end`;
const TOTAL = 600_006;

async function rigWithToken(cursors = new RecoveryCursors()) {
	const rig = recoveryRig();
	const caller: RecoveryCaller = { socketEpoch: "socket-1", sessionId: huge };
	await rig.lane.idle();
	const checkpoint = unwrap(rig.checkpoints.freeze(route(huge), rig.lane));
	const { token } = checkpoint;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	if (!("ref" in manifest.session)) throw new Error("the huge session id must be a ref");
	const pages = new RecoveryPageRequests(rig.checkpoints, cursors);
	const base: RecoveryPageRequest = {
		requestId: "r-0",
		admissionId: token.admission.admissionId,
		token: token.id,
		componentRef: manifest.session.ref,
	};
	const request = (fields: Partial<RecoveryPageRequest>, as: RecoveryCaller = caller) =>
		pages.request(as, { ...base, ...fields });
	return { rig, caller, checkpoint, token, manifest, pages, cursors, base, request, session: manifest.session };
}

const refusal = (outcome: RecoveryPageOutcome) => (outcome.ok ? undefined : outcome.failure);

/** R4.B3 restated: at most eight checkpoint-page requests outstanding on one socket, never read from the owner. */
const SOCKET_PAGE_REQUESTS_MAX = 8;

/** Holds every catalog open (the component's verification) until `release`; the gate reports each entry. */
function heldOpens() {
	const gate = Promise.withResolvers<void>();
	let entered = 0;
	const read = CompactRecoveryCatalog.prototype.read;
	vi.spyOn(CompactRecoveryCatalog.prototype, "read").mockImplementation(async function (
		this: CompactRecoveryCatalog,
		...args: Parameters<CompactRecoveryCatalog["read"]>
	) {
		entered += 1;
		await gate.promise;
		return read.apply(this, args);
	});
	return { release: () => gate.resolve(), entered: () => entered };
}

it("X04 RULING-62 Q1 A a component pages through cursors with one advancing ordinal, exact base64 of the raw bytes, and a digest over the raw bytes", async () => {
	const { request, token, session, rig } = await rigWithToken();
	const expected = Buffer.from(huge, "utf16le");
	expect(expected.length).toBe(TOTAL);
	const answers: RecoveryPageAnswer[] = [];
	let cursor: string | null = null;
	for (let index = 1; cursor !== null || index === 1; index++) {
		const answer: RecoveryPageAnswer = unwrap(
			await request({ requestId: `r-${index}`, ...(cursor === null ? {} : { cursor }) }),
		);
		answers.push(answer);
		cursor = answer.cursor;
	}
	expect(answers.map((page) => [page.ordinal, page.offset, page.length, page.complete])).toEqual([
		[1, 0, FRAGMENT_MAX_BYTES, false],
		[2, FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, false],
		[3, 2 * FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, false],
		[4, 3 * FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, false],
		[5, 4 * FRAGMENT_MAX_BYTES, TOTAL - 4 * FRAGMENT_MAX_BYTES, true],
	]);
	for (const answer of answers) {
		expect(answer).toMatchObject({
			token: token.id,
			generation: token.admission.generation,
			componentRef: session.ref,
			requestId: `r-${answer.ordinal}`,
		});
		const raw = Buffer.from(answer.bytes, "base64");
		expect(raw.length).toBe(answer.length);
		expect(answer.bytes.length).toBeLessThanOrEqual(FRAGMENT_ENVELOPE_MAX_BYTES);
		expect(specDigest("fragment", raw), "the digest is over the raw bytes, verified after base64 decoding").toBe(
			answer.digest,
		);
		expect(answer.cursor === null).toBe(answer.complete);
	}
	const joined = Buffer.concat(answers.map((answer) => Buffer.from(answer.bytes, "base64")));
	expect(joined.equals(expected)).toBe(true);
	expect(FRAGMENT_ENVELOPE_MAX_BYTES).toBe(174_764);
	expect(FRAGMENT_ENVELOPE_MAX_BYTES).toBe(Math.ceil(FRAGMENT_MAX_BYTES / 3) * 4);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-62 Q1 (3) two concurrent requests on one token answer exactly one page and one typed busy that holds no slot and no memory", async () => {
	const { request, pages, rig, token } = await rigWithToken();
	const opens = heldOpens();
	const first = request({ requestId: "r-1" });
	expect(opens.entered(), "the first request is inside its open").toBe(1);
	const before = pages.status();
	const second = await request({ requestId: "r-2" });
	expect(refusal(second)).toEqual({ kind: "request_refused", reason: "busy", hint: "retry" });
	expect(opens.entered(), "the busy answer never reaches a read").toBe(1);
	expect(pages.status()).toEqual({ ...before, refused: { busy: 1 } });
	expect(pages.status().outstanding).toBe(1);
	opens.release();
	const page = unwrap(await first);
	expect(page.ordinal).toBe(1);
	expect(pages.status()).toMatchObject({ outstanding: 0, tokens: 1, cachedBytes: page.bytes.length });
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-69 slow-open rule: an open whose verification is still running is the token's one active request", async () => {
	const { request, rig, token, manifest } = await rigWithToken();
	const opens = heldOpens();
	const first = request({ requestId: "r-1" });
	const other = await request({ requestId: "r-2", componentRef: `${manifest.catalogRoot}:007` });
	expect(refusal(other)).toEqual({ kind: "request_refused", reason: "busy", hint: "retry" });
	opens.release();
	expect(unwrap(await first).ordinal).toBe(1);
	expect(unwrap(await request({ requestId: "r-2", componentRef: `${manifest.catalogRoot}:007` })).ordinal).toBe(2);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-62 Q1 A (1) an exact retry returns identical bytes from the one cached page without a second read; changed parameters under the same request id are refused; the cache is freed on advance and on release", async () => {
	const { request, pages, rig, token, manifest, caller } = await rigWithToken();
	const reads = vi.spyOn(RecoveryCheckpoints.prototype, "readCatalogPage");
	const first = unwrap(await request({ requestId: "r-1" }));
	expect(reads).toHaveBeenCalledTimes(1);
	const retried = unwrap(await request({ requestId: "r-1" }));
	expect(retried).toEqual(first);
	expect(retried.bytes).toBe(first.bytes);
	expect(reads, "a retry is served from the cached page").toHaveBeenCalledTimes(1);
	expect(pages.status()).toMatchObject({ cachedBytes: first.bytes.length, tokens: 1 });
	const activeRef = `${manifest.catalogRoot}:007`;
	expect(refusal(await request({ requestId: "r-1", componentRef: activeRef }))).toEqual({
		kind: "request_refused",
		reason: "request_mismatch",
		hint: "new_request",
	});
	expect(refusal(await request({ requestId: "r-1", cursor: first.cursor ?? undefined }))).toMatchObject({
		reason: "request_mismatch",
	});
	expect(reads).toHaveBeenCalledTimes(1);
	const second = unwrap(await request({ requestId: "r-2", cursor: first.cursor ?? undefined }));
	expect(second.ordinal).toBe(2);
	expect(pages.status().cachedBytes, "only the current page is cached").toBe(second.bytes.length);
	expect(unwrap(await request({ requestId: "r-2", cursor: first.cursor ?? undefined }))).toEqual(second);
	const replayed = unwrap(await request({ requestId: "r-1" }));
	expect(
		[replayed.ordinal, replayed.offset],
		"an old request id is no longer a retry: a fresh page, never a stale one",
	).toEqual([3, 0]);
	expect(pages.status().cachedBytes).toBe(replayed.bytes.length);
	rig.checkpoints.release(token);
	expect(pages.status(), "the release frees the token's cached page and its request state").toMatchObject({
		cachedBytes: 0,
		tokens: 0,
		outstanding: 0,
	});
	expect(
		refusal(
			await pages.request(caller, {
				requestId: "r-3",
				admissionId: "attach-1",
				token: token.id,
				componentRef: activeRef,
			}),
		),
	).toEqual({
		kind: "repair_needed",
		reason: "unknown_token",
	});
	await rig.lane.idle();
});

it("RULING-62 Q2 (1)(3)(4) a tampered, foreign, replayed, mismatched or pre-restart cursor is refused typed before any read, and a foreign peer or session learns nothing", async () => {
	const { request, rig, token, caller, cursors, session, pages } = await rigWithToken();
	const first = unwrap(await request({ requestId: "r-1" }));
	const second = unwrap(await request({ requestId: "r-2", cursor: first.cursor ?? undefined }));
	const reads = vi.spyOn(RecoveryCheckpoints.prototype, "readCatalogPage");
	const invalid = { kind: "request_refused", reason: "invalid_cursor", hint: "restart_from_catalog" };
	const c2 = second.cursor ?? expect.unreachable();
	const mac = c2.slice(-32);
	const tampered = `${c2.slice(0, -32)}${mac.startsWith("0") ? "1" : "0"}${mac.slice(1)}`;
	expect(refusal(await request({ requestId: "r-3", cursor: tampered }))).toEqual(invalid);
	expect(refusal(await request({ requestId: "r-3", cursor: "not/a/cursor" }))).toEqual(invalid);
	expect(
		refusal(await request({ requestId: "r-3", cursor: c2, componentRef: `${c2.slice(0, 0)}c-0000000000000001` })),
	).toEqual(invalid);
	expect(
		refusal(await request({ requestId: "r-3", cursor: first.cursor ?? undefined })),
		"an older cursor replayed",
	).toEqual({
		kind: "request_refused",
		reason: "cursor_out_of_range",
		hint: "restart_from_catalog",
	});
	const foreignPeer: RecoveryCaller = { socketEpoch: "socket-2", sessionId: huge };
	const foreignSession: RecoveryCaller = { socketEpoch: "socket-1", sessionId: "s" };
	const unknown = { kind: "repair_needed", reason: "unknown_token" };
	expect(refusal(await request({ requestId: "r-3", cursor: c2 }, foreignPeer))).toEqual(unknown);
	expect(refusal(await request({ requestId: "r-3", cursor: c2 }, foreignSession))).toEqual(unknown);
	expect(refusal(await request({ requestId: "r-3", cursor: c2, admissionId: "attach-2" }))).toEqual(unknown);
	// Another peer holding its own token for the same session presents the first peer's cursor: unknown cursor, nothing else.
	const other = unwrap(rig.checkpoints.freeze(route(huge, "socket-2"), rig.lane)).token;
	unwrap(await rig.checkpoints.catalog(other, foreignPeer));
	expect(
		refusal(
			await pages.request(foreignPeer, {
				requestId: "r-1",
				admissionId: "attach-1",
				token: other.id,
				componentRef: session.ref,
				cursor: c2,
			}),
		),
	).toEqual(invalid);
	// The same cursor under a new process key (a restart): the client restarts from the catalog.
	const restarted = new RecoveryPageRequests(rig.checkpoints, new RecoveryCursors());
	expect(
		refusal(
			await restarted.request(caller, {
				requestId: "r-3",
				admissionId: "attach-1",
				token: token.id,
				componentRef: session.ref,
				cursor: c2,
			}),
		),
	).toEqual(invalid);
	expect(reads, "no refused request reached the owner's reader").not.toHaveBeenCalled();
	expect(pages.status()).toMatchObject({ tokens: 1 });
	expect(
		cursors.open(c2, {
			socketEpoch: "socket-1",
			sessionId: huge,
			tokenId: token.id,
			generation: 1,
			componentRef: session.ref,
		}),
	).toEqual({ ordinal: 2, offset: 2 * FRAGMENT_MAX_BYTES });
	expect(unwrap(await request({ requestId: "r-3", cursor: c2 })).ordinal).toBe(3);
	rig.checkpoints.release(token);
	rig.checkpoints.release(other);
	await rig.lane.idle();
});

it("RULING-62 Q1 (2) ordinals are 53-bit-safe integers and the bound is a typed refusal, never a wrap", async () => {
	const { request, rig, token, cursors, session } = await rigWithToken();
	const binding = {
		socketEpoch: "socket-1",
		sessionId: huge,
		tokenId: token.id,
		generation: 1,
		componentRef: session.ref,
	};
	const atBound = cursors.mint(binding, { ordinal: Number.MAX_SAFE_INTEGER, offset: FRAGMENT_MAX_BYTES });
	expect(refusal(await request({ requestId: "r-1", cursor: atBound }))).toEqual({
		kind: "request_refused",
		reason: "ordinal_exhausted",
		hint: "release_token",
	});
	const underBound = cursors.mint(binding, { ordinal: Number.MAX_SAFE_INTEGER - 1, offset: FRAGMENT_MAX_BYTES });
	expect(refusal(await request({ requestId: "r-1", cursor: underBound }))).toMatchObject({
		reason: "cursor_out_of_range",
	});
	expect(unwrap(await request({ requestId: "r-2" })).ordinal).toBe(1);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("X04 at most eight page requests are outstanding on one socket across its tokens; the ninth is refused typed before any read", async () => {
	const rig = recoveryRig();
	await rig.lane.idle();
	const pages = new RecoveryPageRequests(rig.checkpoints);
	const tokens = [];
	for (let index = 0; index <= SOCKET_PAGE_REQUESTS_MAX; index++) {
		const sessionId = `s-${index}`;
		const caller: RecoveryCaller = { socketEpoch: "socket-1", sessionId };
		const token = unwrap(rig.checkpoints.freeze(route(sessionId), rig.lane)).token;
		const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
		tokens.push({ token, caller, componentRef: `${manifest.catalogRoot}:007` });
	}
	const opens = heldOpens();
	const inFlight = tokens
		.slice(0, SOCKET_PAGE_REQUESTS_MAX)
		.map(({ token, caller, componentRef }) =>
			pages.request(caller, { requestId: "r-1", admissionId: "attach-1", token: token.id, componentRef }),
		);
	expect(opens.entered()).toBe(SOCKET_PAGE_REQUESTS_MAX);
	expect(pages.status().outstanding).toBe(SOCKET_PAGE_REQUESTS_MAX);
	const ninth = tokens[SOCKET_PAGE_REQUESTS_MAX] ?? expect.unreachable();
	expect(
		refusal(
			await pages.request(ninth.caller, {
				requestId: "r-1",
				admissionId: "attach-1",
				token: ninth.token.id,
				componentRef: ninth.componentRef,
			}),
		),
	).toEqual({ kind: "request_refused", reason: "request_limit", hint: "retry" });
	expect(opens.entered(), "the ninth never reached a read").toBe(SOCKET_PAGE_REQUESTS_MAX);
	opens.release();
	for (const answer of await Promise.all(inFlight)) expect(unwrap(answer).complete).toBe(true);
	expect(pages.status().outstanding).toBe(0);
	expect(
		unwrap(
			await pages.request(ninth.caller, {
				requestId: "r-1",
				admissionId: "attach-1",
				token: ninth.token.id,
				componentRef: ninth.componentRef,
			}),
		).ordinal,
	).toBe(1);
	for (const { token } of tokens) rig.checkpoints.release(token);
	expect(pages.status()).toMatchObject({ tokens: 0, cachedBytes: 0 });
	await rig.lane.idle();
});

it("T5 a malformed request, a node ref and an offset refusal are typed before any read", async () => {
	const { request, rig, token, manifest } = await rigWithToken();
	const reads = vi.spyOn(RecoveryCheckpoints.prototype, "readCatalogPage");
	const malformed = { kind: "request_refused", reason: "malformed_request", hint: "new_request" };
	expect(refusal(await request({ requestId: "" }))).toEqual(malformed);
	expect(refusal(await request({ requestId: "r/1" }))).toEqual(malformed);
	expect(refusal(await request({ requestId: "r-1", componentRef: "../x" }))).toEqual(malformed);
	expect(refusal(await request({ requestId: "r-1", token: "x".repeat(200) }))).toEqual(malformed);
	expect(reads).not.toHaveBeenCalled();
	expect(refusal(await request({ requestId: "r-1", componentRef: manifest.catalogRoot }))).toEqual({
		kind: "storage_unavailable",
		reason: "range",
	});
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

const superseded = { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 };
const unknownToken = { kind: "repair_needed", reason: "unknown_token" };

it("RULING-70 (3) RULING-50 (2) a superseded token its own in-flight page request still holds answers superseded_token with the newer generation, never busy; once reclaimed it is unknown_token", async () => {
	const { request, rig, token, manifest } = await rigWithToken();
	const first = unwrap(await request({ requestId: "r-1" }));
	const opens = heldOpens();
	const inFlight = request({ requestId: "r-2", componentRef: `${manifest.catalogRoot}:007` });
	expect(opens.entered(), "the in-flight request is inside its open").toBe(1);
	const newer = unwrap(rig.checkpoints.freeze(route(huge), rig.lane)).token;
	expect(newer.admission.generation).toBe(2);
	expect(
		rig.checkpoints.tokens().map(({ id }) => id),
		"carry 33: the in-flight read keeps the superseded token object",
	).toContain(token.id);
	const reads = vi.spyOn(RecoveryCheckpoints.prototype, "readCatalogPage");
	expect(refusal(await request({ requestId: "r-3" })), "a new request on the held token").toEqual(superseded);
	expect(
		refusal(await request({ requestId: "r-2", componentRef: `${manifest.catalogRoot}:007` })),
		"the in-flight request's own retry",
	).toEqual(superseded);
	expect(refusal(await request({ requestId: "r-4", cursor: first.cursor ?? undefined })), "a continuation").toEqual(
		superseded,
	);
	expect(reads, "a superseded token is answered before any read").not.toHaveBeenCalled();
	opens.release();
	expect(refusal(await inFlight), "the in-flight request itself").toEqual(superseded);
	expect(
		rig.checkpoints.tokens().map(({ id }) => id),
		"reclaimed once its last operation unwound",
	).not.toContain(token.id);
	expect(refusal(await request({ requestId: "r-5" })), "after the reclaim").toEqual(unknownToken);
	rig.checkpoints.release(newer);
	await rig.lane.idle();
});

it("RULING-70 (3) carry 33 a superseded token another operation still holds never serves its cached page: superseded_token while held, unknown_token after the reclaim", async () => {
	const { request, rig, token, checkpoint, pages, manifest } = await rigWithToken();
	const first = unwrap(await request({ requestId: "r-1" }));
	const gate = Promise.withResolvers<void>();
	const held = checkpoint.hold(() => gate.promise);
	const newer = unwrap(rig.checkpoints.freeze(route(huge), rig.lane)).token;
	expect(rig.checkpoints.tokens().map(({ id }) => id)).toContain(token.id);
	expect(pages.status().cachedBytes, "the cached page still exists while the token is held").toBe(first.bytes.length);
	expect(refusal(await request({ requestId: "r-1" })), "an exact retry of the cached page").toEqual(superseded);
	expect(
		refusal(await request({ requestId: "r-1", componentRef: `${manifest.catalogRoot}:007` })),
		"a changed request under the cached id",
	).toEqual(superseded);
	expect(refusal(await request({ requestId: "r-2", cursor: first.cursor ?? undefined })), "a continuation").toEqual(
		superseded,
	);
	gate.resolve();
	await held;
	expect(rig.checkpoints.tokens().map(({ id }) => id)).not.toContain(token.id);
	expect(pages.status(), "the reclaim frees the cached page").toMatchObject({ cachedBytes: 0, tokens: 0 });
	expect(refusal(await request({ requestId: "r-1" })), "after the reclaim").toEqual(unknownToken);
	rig.checkpoints.release(newer);
	await rig.lane.idle();
});

it("RULING-70 guard: an old request id is a fresh request only without a cursor; a cursor behind the token's ordinal is refused cursor_out_of_range before any read", async () => {
	const { request, rig, token, pages } = await rigWithToken();
	const p1 = unwrap(await request({ requestId: "r-1" }));
	const p2 = unwrap(await request({ requestId: "r-2", cursor: p1.cursor ?? undefined }));
	const p3 = unwrap(await request({ requestId: "r-3", cursor: p2.cursor ?? undefined }));
	expect(p3.ordinal).toBe(3);
	const reads = vi.spyOn(RecoveryCheckpoints.prototype, "readCatalogPage");
	const stale = { kind: "request_refused", reason: "cursor_out_of_range", hint: "restart_from_catalog" };
	expect(
		refusal(await request({ requestId: "r-2", cursor: p1.cursor ?? undefined })),
		"an old request replayed with its own cursor after the token advanced",
	).toEqual(stale);
	expect(
		refusal(await request({ requestId: "r-1", cursor: p2.cursor ?? undefined })),
		"an old id with a later but still behind cursor",
	).toEqual(stale);
	expect(reads, "a behind cursor is never served as a fresh page").not.toHaveBeenCalled();
	expect(pages.status().cachedBytes, "the current page stays cached").toBe(p3.bytes.length);
	const fresh = unwrap(await request({ requestId: "r-2" }));
	expect([fresh.ordinal, fresh.offset], "an old id without a cursor is a fresh first-page request").toEqual([4, 0]);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-69 (2) a request's abort signal stops its first open's verification: typed aborted, its slot and the token's active flag freed, the ordinal not advanced", async () => {
	const { pages, base, caller, rig, token } = await rigWithToken();
	const opens = heldOpens();
	const abort = new AbortController();
	const aborted = pages.request(caller, { ...base, requestId: "r-1" }, abort.signal);
	expect(opens.entered()).toBe(1);
	abort.abort();
	opens.release();
	expect(refusal(await aborted)).toEqual({ kind: "storage_unavailable", reason: "aborted" });
	expect(pages.status()).toMatchObject({ outstanding: 0, cachedBytes: 0 });
	expect(rig.checkpoints.verifiedComponents, "an aborted verification leaves no cache entry").toBe(0);
	const page = unwrap(await pages.request(caller, { ...base, requestId: "r-2" }));
	expect([page.ordinal, page.offset], "the next request is served and takes the first ordinal").toEqual([1, 0]);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});
