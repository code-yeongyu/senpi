import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { strictEd25519Refusal, strictEd25519Verify } from "../../src/modes/rpc/ed25519-strict.ts";
import { openSecretAnswer } from "../../src/modes/rpc/secret-sealed-hpke.ts";
import { closeAccountHosts, type AccountHost } from "./fixtures/presenter-account-host.ts";
import { holder, records, sealedHost } from "./fixtures/secret-sealed-host.ts";
import {
	cancelAnswer,
	hpkeSeal,
	requestHash,
	valueAnswer,
	type AnswerIds,
} from "./fixtures/secret-sealed-presenter.ts";

// D11 secret phase S5-3 (senpi#4249): design 7.1-7.3, 5.3 and 6.5, with omo-relay-spec decision 0022's bytes.
// The presenter side is the independent test implementation in fixtures/secret-sealed-presenter.ts.

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	await closeAccountHosts();
	vi.useRealTimers();
});

type Holder = Awaited<ReturnType<typeof holder>>;

/** A pending sealed-only prompt and what its holder needs to answer it. */
async function prompt(options: { readonly timeout?: number } = {}) {
	const setup = await sealedHost();
	const phone = await holder(setup.host, setup.secret, "phone");
	const state: { value: string | undefined | null } = { value: null };
	void setup.requests
		.input("API key", undefined, options.timeout === undefined ? undefined : { timeout: options.timeout })
		.then((value) => {
			state.value = value;
		});
	const request = (await phone.recorded("mcp_presenter_secret_request"))[0];
	if (!request) throw new Error("No sealed request");
	const hostJkt = setup.host.control.sealed?.tokens.hostJkt ?? "";
	return { ...setup, phone, state, request, req: requestHash(request, hostJkt) };
}

function ids(phone: Holder, request: Record<string, unknown>, req: string, answerId = "answer-1"): AnswerIds {
	return {
		id: `line-${answerId}`,
		req,
		principalId: String(phone.adopted.principalId),
		grantId: String(phone.adopted.acquired?.grantId),
		uiRequestId: String(request.uiRequestId),
		answerId,
	};
}

const deviceKey = (phone: Holder): KeyObject => phone.adopted.device.privateKey;

/** Sends a private record on the device's connection and waits until its asynchronous reply is written. */
async function answer(host: AccountHost, phone: Holder, frame: Record<string, unknown>) {
	host.writer.withConnection(phone.id, () => host.writer.handleMcpForm(frame));
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
	return records(phone.lines, "mcp_presenter_secret_reply").at(-1);
}

const settledFor = (lines: readonly string[]) => records(lines, "mcp_presenter_secret_settled");

it("a holder's sealed value is opened at the latch and settles everyone; the winner alone is not elsewhere", async () => {
	const p = await prompt();
	const tablet = await holder(p.host, p.secret, "tablet");
	const stepup = p.secret.stepUp(p.phone.adopted.device.publicKey, p.req);
	const frame = valueAnswer(ids(p.phone, p.request, p.req), p.request, stepup, "s3cr3t-value", deviceKey(p.phone));
	expect(await answer(p.host, p.phone, frame)).toEqual({
		type: "mcp_presenter_secret_reply",
		id: "line-answer-1",
		disposition: "applied",
	});
	expect(p.state.value).toBe("s3cr3t-value");
	expect(settledFor(p.phone.lines)).toEqual([
		{
			type: "mcp_presenter_secret_settled",
			v: 1,
			uiRequestId: p.request.uiRequestId,
			outcome: "answered",
			elsewhere: false,
		},
	]);
	expect(settledFor(tablet.lines)).toEqual([]);
	expect(await answer(p.host, p.phone, frame)).toMatchObject({ disposition: "replay" });
	const other = valueAnswer(
		ids(p.phone, p.request, p.req, "answer-2"),
		p.request,
		stepup,
		"again",
		deviceKey(p.phone),
	);
	expect(await answer(p.host, p.phone, other)).toMatchObject({ error: "already_answered" });
});

it("a raiser answer wins: the raiser's settle keeps its bytes, holders settle elsewhere, and the late value is never decrypted", async () => {
	const setup = await sealedHost();
	const phone = await holder(setup.host, setup.secret, "phone");
	setup.host.writer.setConnectionCapabilities("human", [
		"interactive_user",
		"mcp_form_presenter_v1",
		"secret_input_v1",
	]);
	void setup.requests.input("API key", undefined);
	const request = (await phone.recorded("mcp_presenter_secret_request"))[0];
	const raised = records(setup.host.lines, "extension_ui_request")[0];
	if (!request || !raised) throw new Error("No prompt");
	const raiserAnswer = {
		type: "extension_ui_response",
		id: "r1",
		uiRequestId: raised.id,
		answerId: "raiser",
		secret: true,
		value: "v",
	};
	expect(setup.host.writer.withConnection("human", () => setup.requests.respond(raiserAnswer))).toMatchObject({
		disposition: "applied",
	});
	await new Promise((resolve) => setImmediate(resolve));
	expect(records(setup.host.lines, "secret_input_settled")).toEqual([
		{ type: "secret_input_settled", id: raised.id, outcome: "answered", sessionId: "session" },
	]);
	expect(settledFor(phone.lines)).toMatchObject([{ outcome: "answered", elsewhere: true }]);
	const req = requestHash(request, setup.host.control.sealed?.tokens.hostJkt ?? "");
	const undecryptable = valueAnswer(
		ids(phone, request, req),
		request,
		setup.secret.stepUp(phone.adopted.device.publicKey, req),
		"late",
		deviceKey(phone),
		{
			sealTo: Buffer.from(
				String(createPublicKey(generateKeyPairSync("x25519").privateKey).export({ format: "jwk" }).x),
				"base64url",
			),
		},
	);
	expect(await answer(setup.host, phone, undecryptable)).toMatchObject({ error: "already_answered" });
});

it("a device whose grant is not in the request's snapshot is refused before anything is checked", async () => {
	const p = await prompt();
	const tablet = await holder(p.host, p.secret, "tablet");
	const frame = valueAnswer(
		{ ...ids(p.phone, p.request, p.req), grantId: String(tablet.adopted.acquired?.grantId) },
		p.request,
		p.secret.stepUp(tablet.adopted.device.publicKey, p.req, { dev: "device-tablet" }),
		"value",
		tablet.adopted.device.privateKey,
	);
	expect(await answer(p.host, tablet, frame)).toMatchObject({ error: "secret_answer_refused" });
	const stolen = valueAnswer(
		ids(p.phone, p.request, p.req),
		p.request,
		p.secret.stepUp(p.phone.adopted.device.publicKey, p.req),
		"v",
		deviceKey(p.phone),
	);
	expect(await answer(p.host, tablet, stolen)).toMatchObject({ error: "secret_answer_refused" });
	expect(p.state.value).toBeNull();
});

const stepUpRefusals = [
	{
		name: "a token for another request",
		// The first character always changes, so the forged hash never equals the real one.
		claims: (p: { req: string }) => ({ req: `${p.req.startsWith("x") ? "y" : "x"}${p.req.slice(1)}` }),
	},
	{ name: "a token bound to another key", claims: () => ({ cnf: { jkt: "another-key" } }) },
	{ name: "a token of another device", claims: () => ({ dev: "device-laptop" }) },
	{ name: "a token for another host device", claims: () => ({ hdev: "another-host" }) },
	{
		name: "a token that outlives the prompt's deadline",
		claims: () => ({ exp: Math.floor(Date.now() / 1000) + 7200 }),
	},
	{ name: "a token of another account", claims: () => ({ acc: "account-b" }) },
];

it.each(stepUpRefusals)("$name is refused secret_stepup_refused and the prompt stays open", async ({ claims }) => {
	const p = await prompt();
	const stepup = p.secret.stepUp(p.phone.adopted.device.publicKey, p.req, {
		iat: Math.floor(Date.now() / 1000),
		...claims(p),
	});
	const frame = valueAnswer(ids(p.phone, p.request, p.req), p.request, stepup, "value", deviceKey(p.phone));
	expect(await answer(p.host, p.phone, frame)).toMatchObject({ error: "secret_stepup_refused" });
	expect(p.state.value).toBeNull();
});

it("a ciphertext that does not open leaves the prompt open, and its step-up token is spent", async () => {
	const p = await prompt();
	const stepup = p.secret.stepUp(p.phone.adopted.device.publicKey, p.req);
	const wrongKey = Buffer.from(
		String(createPublicKey(generateKeyPairSync("x25519").privateKey).export({ format: "jwk" }).x),
		"base64url",
	);
	const bad = valueAnswer(ids(p.phone, p.request, p.req), p.request, stepup, "value", deviceKey(p.phone), {
		sealTo: wrongKey,
	});
	expect(await answer(p.host, p.phone, bad)).toMatchObject({ error: "invalid_secret_response" });
	const nonCanonical = valueAnswer(
		ids(p.phone, p.request, p.req, "answer-2"),
		p.request,
		p.secret.stepUp(p.phone.adopted.device.publicKey, p.req),
		"v",
		deviceKey(p.phone),
		{
			plaintext: Buffer.concat([Buffer.from([0, 0, 0, 1, 0x61]), Buffer.alloc(251, 1)]),
		},
	);
	expect(await answer(p.host, p.phone, nonCanonical)).toMatchObject({ error: "invalid_secret_response" });
	const reused = valueAnswer(
		ids(p.phone, p.request, p.req, "answer-3"),
		p.request,
		stepup,
		"value",
		deviceKey(p.phone),
	);
	expect(await answer(p.host, p.phone, reused)).toMatchObject({ error: "secret_stepup_refused" });
	const fresh = valueAnswer(
		ids(p.phone, p.request, p.req, "answer-4"),
		p.request,
		p.secret.stepUp(p.phone.adopted.device.publicKey, p.req),
		"value",
		deviceKey(p.phone),
	);
	expect(await answer(p.host, p.phone, fresh)).toMatchObject({ disposition: "applied" });
	expect(p.state.value).toBe("value");
});

it("an envelope whose signature is not canonical or not the principal's is invalid (strict Ed25519)", async () => {
	const p = await prompt();
	const frame = valueAnswer(
		ids(p.phone, p.request, p.req),
		p.request,
		p.secret.stepUp(p.phone.adopted.device.publicKey, p.req),
		"v",
		deviceKey(p.phone),
	);
	const signature = Buffer.from(String(frame.sig), "hex");
	const L = (1n << 252n) + 27742317777372353535851937790883648493n;
	let s = 0n;
	for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i] ?? 0);
	s += L;
	for (let i = 32; i < 64; i++, s >>= 8n) signature[i] = Number(s & 0xffn);
	expect(await answer(p.host, p.phone, { ...frame, sig: signature.toString("hex") })).toMatchObject({
		error: "invalid_secret_response",
	});
	const forged = {
		...frame,
		sig: sign(null, Buffer.from("anything"), generateKeyPairSync("ed25519").privateKey).toString("hex"),
	};
	expect(await answer(p.host, p.phone, forged)).toMatchObject({ error: "invalid_secret_response" });
	expect(p.state.value).toBeNull();
});

it("a signed cancel ends the prompt for everyone without a step-up", async () => {
	const p = await prompt();
	const frame = cancelAnswer(ids(p.phone, p.request, p.req), deviceKey(p.phone));
	expect(await answer(p.host, p.phone, frame)).toMatchObject({ disposition: "applied" });
	expect(p.state.value).toBeUndefined();
	expect(settledFor(p.phone.lines)).toMatchObject([{ outcome: "cancelled", elsewhere: false }]);
	expect(await answer(p.host, p.phone, frame)).toMatchObject({ disposition: "replay" });
});

it("a malformed answer is invalid_secret_response, and every reply goes to the sender alone", async () => {
	const p = await prompt();
	const frame = valueAnswer(
		ids(p.phone, p.request, p.req),
		p.request,
		p.secret.stepUp(p.phone.adopted.device.publicKey, p.req),
		"v",
		deviceKey(p.phone),
	);
	for (const malformed of [
		{ ...frame, v: 2 },
		{ ...frame, extra: true },
		{ ...frame, enc: "short" },
		{ ...frame, sig: "00" },
	])
		expect(await answer(p.host, p.phone, malformed)).toMatchObject({ error: "invalid_secret_response" });
	expect(records(p.host.lines, "mcp_presenter_secret_reply")).toEqual([]);
});

it("the strict verifier refuses a small-order key forgery, S >= L and a non-canonical point on every runtime", () => {
	const identity = Buffer.alloc(32);
	identity[0] = 1;
	const message = Buffer.from("omo-secret-answer-v1\n[]");
	expect(strictEd25519Verify(identity, message, Buffer.concat([identity, Buffer.alloc(32)]))).toBe(false);
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
	const signature = sign(null, message, privateKey);
	expect(strictEd25519Verify(raw, message, signature)).toBe(true);
	const L = (1n << 252n) + 27742317777372353535851937790883648493n;
	let s = 0n;
	for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i] ?? 0);
	const nonCanonical = Buffer.from(signature);
	for (let i = 32, v = s + L; i < 64; i++, v >>= 8n) nonCanonical[i] = Number(v & 0xffn);
	expect(strictEd25519Verify(raw, message, nonCanonical)).toBe(false);
	const highY = Buffer.alloc(32, 0xff);
	highY[31] = 0x7f;
	expect(strictEd25519Verify(highY, message, signature)).toBe(false);
});

it("HPKE open and the test-side seal both reproduce RFC 9180's published base-mode vector for this suite", () => {
	const vector = JSON.parse(
		readFileSync(new URL("./fixtures/rfc9180-x25519-sha256-aes256gcm.json", import.meta.url), "utf8"),
	);
	const hex = (value: string) => Buffer.from(value, "hex");
	const sealed = hpkeSeal({
		recipient: hex(vector.pkRm),
		info: hex(vector.info),
		aad: hex(vector.aad),
		plaintext: hex(vector.pt),
		ephemeral: { secret: hex(vector.skEm), public: hex(vector.pkEm) },
	});
	expect(sealed.enc.toString("hex")).toBe(vector.enc);
	expect(sealed.ct.toString("hex")).toBe(vector.ct);
	const privateKey = createPrivateKey({
		key: {
			kty: "OKP",
			crv: "X25519",
			d: hex(vector.skRm).toString("base64url"),
			x: hex(vector.pkRm).toString("base64url"),
		},
		format: "jwk",
	});
	const opened = openSecretAnswer({
		privateKey,
		recipientPublicKey: hex(vector.pkRm),
		enc: hex(vector.enc),
		ct: hex(vector.ct),
		info: hex(vector.info),
		aad: hex(vector.aad),
	});
	expect(opened && Buffer.from(opened).toString("hex")).toBe(vector.pt);
});

it("a receipt names its principal: another holder's same answer id, or the raiser's, is already_answered, never replay", async () => {
	const setup = await sealedHost();
	const phone = await holder(setup.host, setup.secret, "phone");
	const tablet = await holder(setup.host, setup.secret, "tablet");
	setup.host.writer.setConnectionCapabilities("human", [
		"interactive_user",
		"mcp_form_presenter_v1",
		"secret_input_v1",
	]);
	void setup.requests.input("API key", undefined);
	const request = (await phone.recorded("mcp_presenter_secret_request"))[0];
	const raised = records(setup.host.lines, "extension_ui_request")[0];
	if (!request || !raised) throw new Error("No prompt");
	const req = requestHash(request, setup.host.control.sealed?.tokens.hostJkt ?? "");
	const won = valueAnswer(
		ids(phone, request, req),
		request,
		setup.secret.stepUp(phone.adopted.device.publicKey, req),
		"v",
		deviceKey(phone),
	);
	expect(await answer(setup.host, phone, won)).toMatchObject({ disposition: "applied" });
	const sameId = valueAnswer(
		{ ...ids(tablet, request, req), answerId: "answer-1" },
		request,
		setup.secret.stepUp(tablet.adopted.device.publicKey, req, { dev: "device-tablet" }),
		"v",
		tablet.adopted.device.privateKey,
	);
	expect(await answer(setup.host, tablet, sameId)).toMatchObject({ error: "already_answered" });
	const raiserSameId = {
		type: "extension_ui_response",
		id: "r1",
		uiRequestId: raised.id,
		answerId: "answer-1",
		secret: true,
		value: "v",
	};
	expect(setup.host.writer.withConnection("human", () => setup.requests.respond(raiserSameId))).toMatchObject({
		error: "already_answered",
	});
	expect(setup.host.writer.withConnection("human", () => setup.requests.answered())).toEqual([]);
});

const littleEndian32 = (value: bigint) => {
	const out = Buffer.alloc(32);
	for (let i = 0, v = value; i < 32; i++, v >>= 8n) out[i] = Number(v & 0xffn);
	return out;
};
const FIELD_P = (1n << 255n) - 19n;
const GROUP_L = (1n << 252n) + 27742317777372353535851937790883648493n;
const realKey = Buffer.from(
	String(createPublicKey(generateKeyPairSync("ed25519").privateKey).export({ format: "jwk" }).x),
	"base64url",
);
// Self-made points: y = 3 is a curve point of mixed order (not small, outside the prime-order subgroup); y = 3 + p is
// its non-canonical encoding; y = 0 has order 4. Each rule is pinned on its own, whatever the native verifier does.
const strictRules = [
	{ name: "a small-order public key", key: Buffer.alloc(32), r: littleEndian32(3n), s: 0n, refusal: "small_order" },
	{ name: "a small-order R", key: realKey, r: Buffer.alloc(32), s: 0n, refusal: "small_order" },
	{
		name: "a mixed-order public key",
		key: littleEndian32(3n),
		r: littleEndian32(3n),
		s: 0n,
		refusal: "not_prime_order",
	},
	{
		name: "a non-canonical public key",
		key: littleEndian32(3n + FIELD_P),
		r: littleEndian32(3n),
		s: 0n,
		refusal: "encoding",
	},
	{ name: "a non-canonical R", key: realKey, r: littleEndian32(3n + FIELD_P), s: 0n, refusal: "encoding" },
	{
		name: "a negative-zero x (the identity with its sign bit set)",
		key: littleEndian32(1n | (1n << 255n)),
		r: littleEndian32(3n),
		s: 0n,
		refusal: "encoding",
	},
	{ name: "S >= L", key: realKey, r: littleEndian32(3n), s: GROUP_L, refusal: "scalar" },
	{
		name: "a canonical mixed-order R with S < L passes the prechecks",
		key: realKey,
		r: littleEndian32(3n),
		s: GROUP_L - 1n,
		refusal: undefined,
	},
];

it.each(strictRules)("strict Ed25519 prechecks: $name", ({ key, r, s, refusal }) => {
	const scalar = Buffer.alloc(32);
	for (let i = 0, v = s; i < 32; i++, v >>= 8n) scalar[i] = Number(v & 0xffn);
	expect(strictEd25519Refusal(key, Buffer.concat([r, scalar]))).toBe(refusal);
});

it("the claim re-checks the grant: a grant withdrawn while the step-up is verified is refused, and the prompt stays", async () => {
	const setup = await sealedHost();
	const phone = await holder(setup.host, setup.secret, "phone");
	await holder(setup.host, setup.secret, "tablet");
	const state: { value: string | undefined | null } = { value: null };
	void setup.requests.input("API key", undefined).then((value) => {
		state.value = value;
	});
	const request = (await phone.recorded("mcp_presenter_secret_request"))[0];
	if (!request) throw new Error("No sealed request");
	const req = requestHash(request, setup.host.control.sealed?.tokens.hostJkt ?? "");
	setup.secret.hooks.beforeVerify = () => setup.host.writer.setConnectionCapabilities(phone.id, ["interactive_user"]);
	const frame = valueAnswer(
		ids(phone, request, req),
		request,
		setup.secret.stepUp(phone.adopted.device.publicKey, req),
		"v",
		deviceKey(phone),
	);
	expect(await answer(setup.host, phone, frame)).toMatchObject({ error: "secret_answer_refused" });
	expect(state.value).toBeNull();
});

it("a step-up token that expires after the prompt's deadline is refused, even within its own lifetime", async () => {
	const p = await prompt({ timeout: 30_000 });
	const stepup = p.secret.stepUp(p.phone.adopted.device.publicKey, p.req, { exp: Math.floor(Date.now() / 1000) + 90 });
	const frame = valueAnswer(ids(p.phone, p.request, p.req), p.request, stepup, "v", deviceKey(p.phone));
	expect(await answer(p.host, p.phone, frame)).toMatchObject({ error: "secret_stepup_refused" });
	expect(p.state.value).toBeNull();
});

it("an answer that reaches the latch after the deadline times the prompt out instead of applying", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const p = await prompt({ timeout: 30_000 });
	vi.setSystemTime(Date.now() + 31_000);
	const frame = cancelAnswer(ids(p.phone, p.request, p.req), deviceKey(p.phone));
	expect(await answer(p.host, p.phone, frame)).toMatchObject({ error: "unknown_extension_ui_request" });
	expect(settledFor(p.phone.lines)).toMatchObject([{ outcome: "timed_out", elsewhere: true }]);
});

it("unbinding a route removes only its own latch: a second route on the session cannot clear the bound session's latch", async () => {
	const p = await prompt();
	p.host.writer.secretInputRoute("session", true).bindSealedResponder?.(undefined);
	const stepup = p.secret.stepUp(p.phone.adopted.device.publicKey, p.req);
	const frame = valueAnswer(ids(p.phone, p.request, p.req), p.request, stepup, "scoped-value", deviceKey(p.phone));
	expect(await answer(p.host, p.phone, frame)).toMatchObject({ disposition: "applied" });
	expect(p.state.value).toBe("scoped-value");
});

async function reprompt(p: Awaited<ReturnType<typeof prompt>>) {
	const state: { value: string | undefined | null } = { value: null };
	const offered = records(p.phone.lines, "mcp_presenter_secret_request").length;
	void p.requests.input("API key", undefined).then((value) => {
		state.value = value;
	});
	const request = (await p.phone.recorded("mcp_presenter_secret_request", offered + 1)).at(-1);
	if (!request) throw new Error("No sealed request");
	const req = requestHash(request, p.host.control.sealed?.tokens.hostJkt ?? "");
	const stepup = p.secret.stepUp(p.phone.adopted.device.publicKey, req);
	const frame = valueAnswer(
		ids(p.phone, request, req, "answer-2"),
		request,
		stepup,
		"second-value",
		deviceKey(p.phone),
	);
	return { state, reply: await answer(p.host, p.phone, frame) };
}

it("a request set reused after close() still accepts sealed answers: the connection closes it on every rebind", async () => {
	const p = await prompt();
	p.requests.close();
	const second = await reprompt(p);
	expect(second.reply).toMatchObject({ disposition: "applied" });
	expect(second.state.value).toBe("second-value");
});

it("dispose() releases the sealed latch: a later sealed answer on that session is refused", async () => {
	const p = await prompt();
	p.requests.dispose();
	const second = await reprompt(p);
	expect(second.reply).toMatchObject({ error: "secret_answer_refused" });
	expect(second.state.value).toBeNull();
});

it("an answer whose prompt settles while its step-up token is verified answers from the receipt at the latch", async () => {
	const setup = await sealedHost();
	const phone = await holder(setup.host, setup.secret, "phone");
	setup.host.writer.setConnectionCapabilities("human", [
		"interactive_user",
		"mcp_form_presenter_v1",
		"secret_input_v1",
	]);
	void setup.requests.input("API key", undefined);
	const request = (await phone.recorded("mcp_presenter_secret_request"))[0];
	const raised = records(setup.host.lines, "extension_ui_request")[0];
	if (!request || !raised) throw new Error("No prompt");
	const req = requestHash(request, setup.host.control.sealed?.tokens.hostJkt ?? "");
	setup.secret.hooks.beforeVerify = () =>
		setup.host.writer.withConnection("human", () =>
			setup.requests.respond({
				type: "extension_ui_response",
				id: "r1",
				uiRequestId: raised.id,
				answerId: "raiser",
				secret: true,
				value: "v",
			}),
		);
	const frame = valueAnswer(
		ids(phone, request, req),
		request,
		setup.secret.stepUp(phone.adopted.device.publicKey, req),
		"v",
		deviceKey(phone),
	);
	expect(await answer(setup.host, phone, frame)).toMatchObject({ error: "already_answered" });
});

it("a settled prompt takes no more host token records when the token is re-minted", async () => {
	const setup = await sealedHost({ lifetimeS: 600 });
	const phone = await holder(setup.host, setup.secret, "phone");
	void setup.requests.input("API key", undefined);
	const request = (await phone.recorded("mcp_presenter_secret_request"))[0];
	if (!request) throw new Error("No sealed request");
	const req = requestHash(request, setup.host.control.sealed?.tokens.hostJkt ?? "");
	expect(await answer(setup.host, phone, cancelAnswer(ids(phone, request, req), deviceKey(phone)))).toMatchObject({
		disposition: "applied",
	});
	vi.advanceTimersByTime(401_000);
	await setup.secret.mints.at(-1)?.done;
	expect(setup.secret.mints.length).toBeGreaterThan(1);
	expect(records(phone.lines, "mcp_presenter_secret_token")).toEqual([]);
});
