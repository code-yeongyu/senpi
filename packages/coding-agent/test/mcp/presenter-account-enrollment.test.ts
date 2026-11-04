import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import {
	accountHost,
	claimsOf,
	closeAccountHosts,
	enroll,
	enrollAssignAcquire,
	installation,
	issuer,
	signedCommand,
} from "./fixtures/presenter-account-host.ts";

afterEach(closeAccountHosts);

const nowS = () => Math.floor(Date.now() / 1000);

it("T1: a same-account installation enrolls on an adopted host with no owner prompt", async () => {
	const host = await accountHost();
	const { challenge, reply, assigned, acquired, token, device } = await enrollAssignAcquire(host);
	const claims = claimsOf(token);
	expect(challenge).toMatchObject({ type: "challenge", version: 1, hostInstance: expect.any(String) });
	expect(JSON.parse(String(challenge?.transcript))).toEqual([
		"mcp-presenter-account-enroll-v1",
		"mcp_form",
		challenge?.hostInstance,
		"account-a",
		"account-a",
		"device-a",
		device.installationKeyId,
		claims.jti,
		expect.stringMatching(/^[a-f0-9]{64}$/),
		30000,
	]);
	expect(reply).toEqual({
		type: "account_enrolled",
		version: 1,
		principalId: expect.any(String),
		hostInstance: challenge?.hostInstance,
		attestedUntil: claims.exp,
	});
	expect(assigned).toMatchObject({ type: "mcp_presenter_assigned", sessionId: "session" });
	expect(acquired).toMatchObject({ type: "mcp_presenter_acquired", id: "acquire" });
	expect(host.binding.capture()?.ready()).toBe(true);
	expect(host.lines.filter((line) => line.includes("ui_request"))).toEqual([]);
});

it("T2: ordinary RPC, an unknown principal and a missing or invalid attestation cannot enroll", async () => {
	const host = await accountHost();
	const device = installation();
	const frame = device.frame(issuer.mint(device.publicKey));
	expect(host.writer.withConnection("human", () => host.writer.handleMcpForm(frame))).toBe(false);
	const unknown = host.open();
	expect(
		await signedCommand(unknown, "unknown-principal", device.privateKey, {
			type: "mcp_presenter_assign",
			sessionId: "session",
			bindingEpoch: host.binding.epoch,
			purpose: "mcp_form",
		}),
	).toBeUndefined();
	const missing = host.open();
	const { attestation: _attestation, ...withoutAttestation } = frame;
	missing.send(withoutAttestation);
	expect(await missing.next()).toBeUndefined();
	const invalid = host.open();
	invalid.send(device.frame("not-a-token"));
	expect(await invalid.next()).toEqual({ type: "account_refused", version: 1, reason: "attestation_malformed" });
	expect(await invalid.next()).toBeUndefined();
	expect(host.binding.capture()).toBeUndefined();
});

it.each([
	["no account authority", { authority: false, inheritedBootstrap: new PassThrough() }, false],
	["a signed-out host", {}, true],
] as const)("account enrollment fails closed with %s", async (_name, options, signedOut) => {
	const host = await accountHost(options);
	if (signedOut) host.state.account = undefined;
	const device = installation();
	const peer = host.open();
	peer.send(device.frame(issuer.mint(device.publicKey)));
	expect(await peer.next()).toEqual({ type: "account_refused", version: 1, reason: "presenter_account_unavailable" });
	expect(await peer.next()).toBeUndefined();
});

const forgedIssuer = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const refusals: ReadonlyArray<readonly [string, string, (key: KeyObject) => string]> = [
	["a token issued for another key (cnf)", "attestation_key_mismatch", () => issuer.mint(installation().publicKey)],
	["another account", "presenter_account_mismatch", (key) => issuer.mint(key, { acc: "account-b" })],
	["a relay token (wrong aud)", "attestation_audience", (key) => issuer.mint(key, { aud: "omo-relay", typ: "relay" })],
	["an expired token", "attestation_expired", (key) => issuer.mint(key, { iat: nowS() - 2000, exp: nowS() - 1100 })],
	["another issuer key", "attestation_signature", (key) => issuer.mint(key, {}, forgedIssuer)],
	["an empty dev", "attestation_malformed", (key) => issuer.mint(key, { dev: "" })],
	["a 257-character dev", "attestation_malformed", (key) => issuer.mint(key, { dev: "d".repeat(257) })],
	["a 257-character dname", "attestation_malformed", (key) => issuer.mint(key, { dname: "n".repeat(257) })],
	["a control character in dname", "attestation_malformed", (key) => issuer.mint(key, { dname: "Work\u0007laptop" })],
	["a line break in dev", "attestation_malformed", (key) => issuer.mint(key, { dev: "device\na" })],
];
it.each(refusals)("T3: socket access alone cannot enroll with %s: %s", async (_name, reason, token) => {
	const host = await accountHost();
	const device = installation();
	const peer = host.open();
	peer.send(device.frame(token(device.publicKey)));
	expect(await peer.next()).toEqual({ type: "account_refused", version: 1, reason });
	expect(await peer.next()).toBeUndefined();
	expect(host.binding.capture()).toBeUndefined();
});

it("T3: a replayed jti is refused, even after the first enrollment succeeded", async () => {
	const host = await accountHost();
	const device = installation();
	const token = issuer.mint(device.publicKey);
	expect((await enroll(host.open(), device, token)).reply).toMatchObject({ type: "account_enrolled" });
	const replay = await enroll(host.open(), device, token);
	expect(replay.reply).toEqual({ type: "account_refused", version: 1, reason: "attestation_replayed" });
});

it("T3: a valid token with a transcript signature from another key is refused", async () => {
	const host = await accountHost();
	const device = installation();
	const peer = host.open();
	const attempt = await enroll(peer, device, issuer.mint(device.publicKey), installation().privateKey);
	expect(attempt.challenge).toMatchObject({ type: "challenge" });
	expect(attempt.reply).toEqual({ type: "account_refused", version: 1, reason: "presenter_proof_invalid" });
	expect(await peer.next()).toBeUndefined();
});
