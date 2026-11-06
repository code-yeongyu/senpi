import { createHash, createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SecretInputRequests } from "../../src/modes/rpc/secret-input-requests.ts";
import * as sealedKeys from "../../src/modes/rpc/secret-sealed.ts";
import {
	claimsOf,
	closeAccountHosts,
	enrollAssignAcquire,
	installation,
	signedCommand,
} from "./fixtures/presenter-account-host.ts";
import { jwkThumbprint } from "./fixtures/presenter-account-issuer.ts";
import { holder, type Line, nowS, records, SECRET, sealedHost, sealedTypes } from "./fixtures/secret-sealed-host.ts";

// D11 secret phase S5-2 (senpi#4249): design 5.1, 5.2 and 4.2-4.3; the binding follows omo-relay-spec decision 0022.
// Only the host's timers are faked; sockets, the issuer's ES256 and every Ed25519/X25519 key stay real.

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	await closeAccountHosts();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** The design 4.2 binding, rebuilt here from the received record: an oracle independent of the engine's helper. */
function binding(request: Line, title = request.title, placeholder = request.placeholder) {
	const displayHash = createHash("sha256")
		.update(JSON.stringify([title, placeholder ?? null]))
		.digest("base64url");
	return [
		"omo-secret-binding-v1",
		request.hostInstance,
		hostJkt(request),
		request.durableSessionId,
		request.uiRequestId,
		request.deadlineAtMs,
		request.hpkePk,
		displayHash,
	];
}
const hostKey = (request: Line) =>
	createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: String(request.hostPk) }, format: "jwk" });
const hostJkt = (request: Line) => jwkThumbprint(hostKey(request));
const signed = (request: Line, b: unknown[]) =>
	verify(
		null,
		Buffer.from(`omo-secret-request-v1\n${JSON.stringify(b)}`),
		hostKey(request),
		Buffer.from(String(request.sig), "hex"),
	);

it("a raiser-refused secret with no sealed holder keeps today's refusal", async () => {
	const { requests } = await sealedHost();
	await expect(requests.input("API key", undefined)).rejects.toMatchObject({ reason: "no_presenter" });
});

// senpi#6062: failed key generation must close the latch without offering a request.
it("a request key failure settles unavailable without sending an unmatched holder frame", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	host.writer.setConnectionCapabilities("human", ["interactive_user", "mcp_form_presenter_v1", "secret_input_v1"]);
	const key = Promise.withResolvers<sealedKeys.SecretRequestKey>();
	vi.spyOn(sealedKeys, "generateSecretRequestKey").mockReturnValueOnce(key.promise);
	let result: string | undefined | null = null;
	void requests.input("API key", undefined).then((value) => {
		result = value;
	});
	await host.human.recorded("extension_ui_request");
	key.reject(new Error("injected key failure"));
	await key.promise.catch(() => undefined);
	expect(result).toBeUndefined();
	expect(await host.human.recorded("secret_input_settled")).toMatchObject([{ outcome: "unavailable" }]);
	expect(sealedTypes(phone.lines)).toEqual([]);
});

// senpi#6062: explicit key gate, with settlement before the asynchronous offer can leave.
it("a request settled before its key resolves never offers or settles a holder request", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	const generated = await sealedKeys.generateSecretRequestKey();
	const key = Promise.withResolvers<sealedKeys.SecretRequestKey>();
	vi.spyOn(sealedKeys, "generateSecretRequestKey").mockReturnValueOnce(key.promise);
	const result = requests.input("API key", undefined);
	requests.cancelAll();
	expect(await result).toBeUndefined();
	key.resolve(generated);
	await key.promise;
	expect(sealedTypes(phone.lines)).toEqual([]);
});

it("a raiser-refused secret with one sealed holder proceeds on the sealed route, signed by the host key", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	void requests.input("API key", "sk-...");
	const [request] = await phone.recorded("mcp_presenter_secret_request");
	expect(request && Object.keys(request).sort()).toEqual(
		[
			"type",
			"v",
			"sessionId",
			"durableSessionId",
			"uiRequestId",
			"title",
			"placeholder",
			"deadlineAtMs",
			"hostInstance",
			"hpkePk",
			"hostPk",
			"hostToken",
			"sig",
		].sort(),
	);
	if (!request) throw new Error("No sealed request");
	expect(request).toMatchObject({
		v: 1,
		sessionId: "session",
		durableSessionId: "durable",
		title: "API key",
		placeholder: "sk-...",
		hostInstance: host.authority.instance,
	});
	expect(Buffer.from(String(request.hpkePk), "base64url")).toHaveLength(32);
	expect(claimsOf(String(request.hostToken)).cnf).toEqual({ jkt: hostJkt(request) });
	expect(signed(request, binding(request))).toBe(true);
	expect(signed(request, binding(request, "Other title"))).toBe(false);
	expect(signed(request, binding(request, request.title, "other"))).toBe(false);
});

const notHolders = [
	{ name: "a grant without secret_input_v1", features: [] as string[], lapse: false },
	{ name: "a principal whose host account changed", features: SECRET, lapse: true },
];

it.each(notHolders)("$name is never a sealed holder", async ({ features, lapse }) => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone", features);
	if (lapse) host.state.account = "account-b";
	await expect(requests.input("API key", undefined)).rejects.toMatchObject({ reason: "no_presenter" });
	expect(sealedTypes(phone.lines)).toEqual([]);
});

it("an inherited grant with secret_input_v1 is never a sealed holder", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = host.presenter("phone");
	const owner = host.authority.enroll("inherited");
	owner.acquire(owner.register(host.binding, phone.connection, { kind: "desktop", features: SECRET }));
	await expect(requests.input("API key", undefined)).rejects.toMatchObject({ reason: "no_presenter" });
	expect(secret.mints).toHaveLength(0);
	expect(sealedTypes(phone.lines)).toEqual([]);
});

it("a holder with no valid host token is not a sealed holder", async () => {
	const { host, secret, requests } = await sealedHost();
	secret.plan({ fail: true });
	await holder(host, secret, "phone");
	await expect(requests.input("API key", undefined)).rejects.toMatchObject({ reason: "no_presenter" });
});

it("a grant without the feature never receives a sealed record while another device holds the request", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	const laptop = await holder(host, secret, "laptop", []);
	void requests.input("API key", undefined);
	await phone.recorded("mcp_presenter_secret_request");
	expect(sealedTypes(phone.lines)).toEqual(["mcp_presenter_secret_request"]);
	expect(sealedTypes(laptop.lines)).toEqual([]);
});

it("a sealed-only request survives capability changes and another device's detach, and ends unavailable with its last holder", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	await holder(host, secret, "tablet");
	let settled: string | undefined | null = null;
	void requests.input("API key", undefined).then((value) => {
		settled = value;
	});
	await phone.recorded("mcp_presenter_secret_request");
	host.writer.setConnectionCapabilities("human", ["interactive_user", "mcp_form_presenter_v1", "raiser_notice_v1"]);
	host.writer.setSoleSecretCapabilities(["interactive_user", "secret_input_v1"]);
	host.writer.detachConnectionFromSession("human", "session");
	host.writer.detachConnectionFromSession("tablet", "session");
	await Promise.resolve();
	expect(settled).toBeNull();
	host.writer.detachConnectionFromSession("phone", "session");
	await Promise.resolve();
	expect(settled).toBeUndefined();
	expect(sealedTypes(phone.lines)).toEqual(["mcp_presenter_secret_request", "mcp_presenter_secret_settled"]);
});

it("a raiser detach leaves a request with a current sealed holder alive", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	host.writer.setConnectionCapabilities("human", ["interactive_user", "mcp_form_presenter_v1", "secret_input_v1"]);
	let settled: string | undefined | null = null;
	void requests.input("API key", undefined).then((value) => {
		settled = value;
	});
	expect(records(host.lines, "extension_ui_request")).toHaveLength(1);
	await phone.recorded("mcp_presenter_secret_request");
	expect(sealedTypes(phone.lines)).toEqual(["mcp_presenter_secret_request"]);
	host.writer.unregisterConnection("human");
	await Promise.resolve();
	expect(settled).toBeNull();
});

it("a sealed-only request never accepts an extension_ui_response, not even from the sole connection", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	host.writer.setSoleSecretCapabilities(["interactive_user", "secret_input_v1"]);
	void requests.input("API key", undefined);
	const [request] = await phone.recorded("mcp_presenter_secret_request");
	const answer = {
		type: "extension_ui_response",
		id: "answer",
		uiRequestId: request?.uiRequestId,
		answerId: "a",
		secret: true,
		value: "plaintext",
	};
	expect(requests.respond(answer)).toMatchObject({ success: false, error: "secret_answer_refused" });
	expect(host.writer.withConnection("phone", () => requests.respond(answer))).toMatchObject({
		success: false,
		error: "secret_answer_refused",
	});
	expect(records(host.lines, "extension_ui_request")).toEqual([]);
});

it("a re-mint reaches every holder of a pending request, which stays answerable after the old token expires", async () => {
	const { host, secret, requests } = await sealedHost({ lifetimeS: 600 });
	const phone = await holder(host, secret, "phone");
	let settled: string | undefined | null = null;
	void requests.input("API key", undefined).then((value) => {
		settled = value;
	});
	const [request] = await phone.recorded("mcp_presenter_secret_request");
	if (!request) throw new Error("No sealed request");
	vi.advanceTimersByTime(401_000);
	await secret.mints.at(-1)?.done;
	const [token] = records(phone.lines, "mcp_presenter_secret_token");
	expect(token).toEqual({
		type: "mcp_presenter_secret_token",
		v: 1,
		hostInstance: host.authority.instance,
		durableSessionId: "durable",
		hostToken: host.control.sealed?.tokens.current("durable")?.token,
	});
	expect(claimsOf(String(token?.hostToken)).cnf).toEqual({ jkt: binding(request)[2] });
	vi.advanceTimersByTime(200_000);
	await Promise.resolve();
	expect(settled).toBeNull();
	expect(signed(request, binding(request))).toBe(true);
});

it("attached devices that are not sealed holders keep the value-free notice; the holder gets the request instead", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	host.writer.setConnectionCapabilities("human", ["interactive_user", "mcp_form_presenter_v1", "raiser_notice_v1"]);
	host.writer.setConnectionCapabilities("phone", ["interactive_user", "mcp_form_presenter_v1", "raiser_notice_v1"]);
	void requests.input("API key", undefined);
	expect(records(host.lines, "secret_input_notice")).toHaveLength(1);
	expect(records(phone.lines, "secret_input_notice")).toEqual([]);
	await phone.recorded("mcp_presenter_secret_request");
	expect(sealedTypes(phone.lines)).toEqual(["mcp_presenter_secret_request"]);
});

it("a route without the sealed flag (a worker isolate's, until S5-4) never adds sealed holders", async () => {
	const { host, secret } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	const requests = new SecretInputRequests(host.writer.secretInputRoute("session"), () => {});
	await expect(requests.input("API key", undefined)).rejects.toMatchObject({ reason: "no_presenter" });
	expect(sealedTypes(phone.lines)).toEqual([]);
});

it("revoking the last holder's grant on the control channel ends a sealed-only request unavailable", async () => {
	const { host, secret, requests } = await sealedHost();
	const phone = await holder(host, secret, "phone");
	let settled: string | undefined | null = null;
	void requests.input("API key", undefined).then((value) => {
		settled = value;
	});
	await phone.recorded("mcp_presenter_secret_request");
	expect(sealedTypes(phone.lines)).toEqual(["mcp_presenter_secret_request"]);
	const revoked = await signedCommand(phone.adopted.peer, phone.adopted.principalId, phone.adopted.device.privateKey, {
		type: "mcp_presenter_revoke",
		id: "revoke",
		registrationId: phone.adopted.acquired?.registrationId,
	});
	expect(revoked).toMatchObject({ type: "mcp_presenter_revoked" });
	await Promise.resolve();
	expect(settled).toBeUndefined();
});

it("a principal whose attestation lapsed is not a sealed holder while its grant and the host token stay valid", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const { host, secret, requests } = await sealedHost({ lifetimeS: 900 });
	const device = host.presenter("phone");
	await enrollAssignAcquire(host, installation(), {
		context: device.context,
		claims: { dev: "device-phone", exp: nowS() + 60 },
		features: SECRET,
	});
	await secret.mints.at(-1)?.done;
	vi.setSystemTime(Date.now() + 120_000);
	expect(host.control.sealed?.tokens.current("durable")).toBeDefined();
	expect(host.binding.capture()).toBeDefined();
	await expect(requests.input("API key", undefined)).rejects.toMatchObject({ reason: "no_presenter" });
	expect(sealedTypes(device.lines)).toEqual([]);
});

it("the host key signs only a binding that names this host instance and this key", async () => {
	const { host, secret } = await sealedHost();
	await holder(host, secret, "phone");
	const tokens = host.control.sealed?.tokens;
	if (!tokens) throw new Error("No sealed route");
	const foreign = [
		"omo-secret-binding-v1",
		"another-host",
		tokens.hostJkt,
		"durable",
		"r",
		1,
		tokens.hostJkt,
		tokens.hostJkt,
	] as const;
	expect(() => tokens.signRequest(foreign)).toThrow("secret_request_foreign");
	const otherKey = [
		"omo-secret-binding-v1",
		host.authority.instance,
		"another-key",
		"durable",
		"r",
		1,
		tokens.hostJkt,
		tokens.hostJkt,
	] as const;
	expect(() => tokens.signRequest(otherKey)).toThrow("secret_request_foreign");
});
