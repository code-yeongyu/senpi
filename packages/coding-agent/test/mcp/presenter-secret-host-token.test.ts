import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PresenterAccountAuthority, SecretHostTokenRequest } from "../../src/modes/rpc/mcp-presenter-account.ts";
import { McpPresenterAuthority } from "../../src/modes/rpc/mcp-presenter-authority.ts";
import { SecretHostTokens } from "../../src/modes/rpc/secret-host-token.ts";
import {
	accountHost,
	claimsOf,
	closeAccountHosts,
	enrollAssignAcquire,
	installation,
	issuer,
	type AccountHost,
} from "./fixtures/presenter-account-host.ts";
import { secretHostIssuer } from "./fixtures/secret-host-issuer.ts";

// D11 secret phase S5-1 (senpi#4249): design sections 3.1 and 3.2. Only the host's timers are faked, so the refresh
// is driven explicitly; sockets, the issuer's ES256 and the host key's Ed25519 stay real.
const SECRET = ["secret_input_v1"];
const nowS = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	await closeAccountHosts();
	vi.useRealTimers();
});

async function secretHost(lifetimeS?: number) {
	const secret = secretHostIssuer(issuer, lifetimeS);
	const host = await accountHost({ account: secret.authority });
	return { host, secret };
}

function phone(host: AccountHost, features?: readonly string[]) {
	const connection = host.presenter("phone");
	return enrollAssignAcquire(host, installation(), {
		context: connection.context,
		claims: { dev: "device-b" },
		...(features && { features }),
	});
}

it("the first secret_input_v1 acquire mints one host token for (hin, sid), proven with this instance's host key", async () => {
	const { host, secret } = await secretHost();
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
	const adopted = await enrollAssignAcquire(host, installation(), { features: SECRET });
	expect(adopted.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	expect(secret.mints).toHaveLength(1);
	const [mint] = secret.mints;
	await mint?.done;
	expect(mint?.request).toMatchObject({ hostInstance: host.authority.instance, durableSessionId: "durable" });
	expect(mint?.proofVerified).toBe(true);
	const token = host.control.sealed?.tokens.current("durable");
	expect(token).toMatchObject({ acc: "account-a", dev: "host-device" });
	expect(claimsOf(token?.token ?? "")).toEqual(mint?.claims);

	await phone(host, SECRET);
	expect(secret.mints).toHaveLength(1);

	const other = await secretHost();
	await enrollAssignAcquire(other.host, installation(), { features: SECRET });
	const otherKey = other.secret.mints[0]?.request.hostKeySpki;
	expect(otherKey && Buffer.from(otherKey).equals(Buffer.from(mint?.request.hostKeySpki ?? []))).toBe(false);
});

it("an acquire without secret_input_v1 mints nothing", async () => {
	const { host, secret } = await secretHost();
	const adopted = await enrollAssignAcquire(host, installation(), { features: ["elsewhere_v1"] });
	expect(adopted.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	expect(secret.mints).toHaveLength(0);
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
});

it("an authority without both secret methods gets no host key and no call; the acquired reply keeps its keys", async () => {
	const mint = vi.fn<(request: SecretHostTokenRequest) => Promise<string>>();
	const mintOnly = (state: AccountHost["state"]): PresenterAccountAuthority => ({
		...issuer.authority(state),
		mintSecretHostToken: mint,
	});
	expect(SecretHostTokens.create("instance", undefined)).toBeUndefined();
	expect(SecretHostTokens.create("instance", issuer.authority({ account: "account-a" }))).toBeUndefined();
	expect(
		SecretHostTokens.create("instance", mintOnly({ account: "account-a", listeners: new Set() })),
	).toBeUndefined();

	const host = await accountHost({ account: mintOnly });
	const withFeature = await enrollAssignAcquire(host, installation(), { features: SECRET });
	const without = await enrollAssignAcquire(await accountHost());
	expect(withFeature.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	expect(Object.keys(withFeature.acquired ?? {})).toEqual(Object.keys(without.acquired ?? {}));
	expect(mint).not.toHaveBeenCalled();
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
});

it("the token stays while any secret_input_v1 grant holds the session and is dropped with the last one", async () => {
	const { host, secret } = await secretHost();
	await enrollAssignAcquire(host, installation(), { features: SECRET });
	await secret.mints[0]?.done;
	await phone(host, SECRET);
	const timers = vi.getTimerCount();
	host.writer.detachConnectionFromSession("phone", "session");
	expect(host.control.sealed?.tokens.current("durable")).toBeDefined();
	host.writer.detachConnectionFromSession("human", "session");
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
	// The refresh timer goes with the token; the principals' attestation timers stay.
	expect(vi.getTimerCount()).toBe(timers - 1);
});

it("a grant without the feature does not keep the token alive", async () => {
	const { host, secret } = await secretHost();
	await enrollAssignAcquire(host, installation(), { features: SECRET });
	await secret.mints[0]?.done;
	await phone(host);
	host.writer.detachConnectionFromSession("human", "session");
	expect(host.binding.capture()).toBeDefined();
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
});

it("the token is re-minted at two thirds of its lifetime, not before", async () => {
	const { host, secret } = await secretHost(600);
	await enrollAssignAcquire(host, installation(), { features: SECRET, claims: { exp: nowS() + 900 } });
	await secret.mints[0]?.done;
	const first = host.control.sealed?.tokens.current("durable");
	vi.advanceTimersByTime(399_000);
	expect(secret.mints).toHaveLength(1);
	vi.advanceTimersByTime(2_000);
	expect(secret.mints).toHaveLength(2);
	await secret.mints[1]?.done;
	const second = host.control.sealed?.tokens.current("durable");
	expect(second?.token).not.toBe(first?.token);
	expect(claimsOf(second?.token ?? "")).toEqual(secret.mints[1]?.claims);
});

it("a failed re-mint is retried while a holder remains, and the old token serves until then", async () => {
	const { host, secret } = await secretHost(600);
	await enrollAssignAcquire(host, installation(), { features: SECRET, claims: { exp: nowS() + 900 } });
	await secret.mints[0]?.done;
	const first = host.control.sealed?.tokens.current("durable");
	secret.plan({ fail: true });
	vi.advanceTimersByTime(401_000);
	await secret.mints[1]?.done;
	expect(host.control.sealed?.tokens.current("durable")).toEqual(first);
	vi.advanceTimersByTime(59_000);
	expect(secret.mints).toHaveLength(2);
	vi.advanceTimersByTime(2_000);
	expect(secret.mints).toHaveLength(3);
	await secret.mints[2]?.done;
	expect(claimsOf(host.control.sealed?.tokens.current("durable")?.token ?? "")).toEqual(secret.mints[2]?.claims);
});

it("the refresh is measured on the local clock, so an issuer iat in the past does not bring it forward", async () => {
	const { host, secret } = await secretHost();
	secret.plan({ claims: { iat: nowS() - 500, exp: nowS() + 300 } });
	await enrollAssignAcquire(host, installation(), { features: SECRET });
	await secret.mints[0]?.done;
	expect(host.control.sealed?.tokens.current("durable")).toBeDefined();
	vi.advanceTimersByTime(190_000);
	expect(secret.mints).toHaveLength(1);
	vi.advanceTimersByTime(11_000);
	expect(secret.mints).toHaveLength(2);
});

it("a mint that has not settled in 30 s counts as failed and its late result is ignored", async () => {
	const { host, secret } = await secretHost();
	secret.plan({ hold: true });
	await enrollAssignAcquire(host, installation(), { features: SECRET });
	vi.advanceTimersByTime(30_001);
	await phone(host, SECRET);
	expect(secret.mints).toHaveLength(2);
	await secret.mints[1]?.done;
	secret.release();
	await secret.mints[0]?.done;
	expect(claimsOf(host.control.sealed?.tokens.current("durable")?.token ?? "")).toEqual(secret.mints[1]?.claims);
});

it("only an account-principal grant with the feature needs a token; an inherited one neither mints nor keeps it", async () => {
	const secret = secretHostIssuer(issuer);
	const authority = new McpPresenterAuthority();
	const binding = authority.bind("session", "durable", () => {});
	const grant = (id: string, identity?: { principalKind: "account"; dev: string; dname: string }) => {
		const sender = authority.connect(id, () => true);
		authority.attach(sender, binding);
		const owner = authority.enroll(`principal-${id}`, identity);
		const registration = owner.register(binding, sender, { kind: "desktop", features: SECRET });
		owner.acquire(registration);
		return () => owner.revoke(registration);
	};
	const tokens = SecretHostTokens.create(authority.instance, secret.authority({ account: "account-a" }));
	const held = () => authority.secretInputHeld(binding);
	grant("inherited");
	tokens?.want("durable", binding, held);
	expect(held()).toBe(false);
	expect(secret.mints).toHaveLength(0);
	const revokeAccount = grant("account", { principalKind: "account", dev: "device-a", dname: "Laptop" });
	tokens?.want("durable", binding, held);
	expect(secret.mints).toHaveLength(1);
	await secret.mints[0]?.done;
	grant("inherited-2");
	revokeAccount();
	expect(tokens?.current("durable")).toBeUndefined();
	tokens?.dispose();
	authority.dispose();
});

it("a signed-out host makes no refresh call and holds no valid token", async () => {
	const { host, secret } = await secretHost(600);
	await enrollAssignAcquire(host, installation(), { features: SECRET, claims: { exp: nowS() + 900 } });
	await secret.mints[0]?.done;
	host.state.account = undefined;
	vi.advanceTimersByTime(401_000);
	expect(secret.mints).toHaveLength(1);
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
});

it("a mint still in flight when the last grant leaves is discarded", async () => {
	const { host, secret } = await secretHost();
	secret.plan({ hold: true });
	await enrollAssignAcquire(host, installation(), { features: SECRET });
	host.writer.detachConnectionFromSession("human", "session");
	secret.release();
	await secret.mints[0]?.done;
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
	expect(vi.getTimerCount()).toBe(1);
});

const refused = [
	{ name: "another session", claims: { sid: "other" } },
	{ name: "another host instance", claims: { hin: "other" } },
	{ name: "another key", claims: { cnf: { jkt: "other" } } },
	{ name: "another account", claims: { acc: "account-b" } },
	{ name: "a presenter audience", claims: { aud: "omo-mcp-presenter" } },
	{ name: "a presenter type", claims: { typ: "mcp_presenter" } },
	{ name: "a lifetime over 900 s", claims: { iat: nowS(), exp: nowS() + 901 } },
	{ name: "an expired lifetime", claims: { iat: nowS() - 600, exp: nowS() - 1 } },
	{ name: "an issuer fault", fail: true },
];

it.each(refused)("a mint result naming $name is never cached and is retried within 60 s", async (plan) => {
	const { host, secret } = await secretHost();
	secret.plan(plan);
	await enrollAssignAcquire(host, installation(), { features: SECRET });
	await secret.mints[0]?.done;
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
	vi.advanceTimersByTime(59_000);
	expect(secret.mints).toHaveLength(1);
	vi.advanceTimersByTime(2_000);
	expect(secret.mints).toHaveLength(2);
	await secret.mints[1]?.done;
	expect(host.control.sealed?.tokens.current("durable")).toMatchObject({ acc: "account-a" });
});

it("the proof callback signs only bounded claims and only while its mint is pending", async () => {
	const { host, secret } = await secretHost();
	const outcomes: string[] = [];
	let request: SecretHostTokenRequest | undefined;
	const attempt = (proof: { issuer: string; nonce: string }) => {
		try {
			request?.sign(proof);
			outcomes.push("signed");
		} catch (error) {
			outcomes.push(error instanceof Error ? error.message : "thrown");
		}
	};
	secret.plan({
		during: (pending) => {
			request = pending;
			attempt({ issuer: "https://account.example\nomo-secret-host", nonce: "n" });
			attempt({ issuer: "https://account.example", nonce: "" });
			attempt({ issuer: "https://account.example", nonce: "n" });
		},
	});
	await enrollAssignAcquire(host, installation(), { features: SECRET });
	await secret.mints[0]?.done;
	attempt({ issuer: "https://account.example", nonce: "n" });
	expect(outcomes).toEqual([
		"secret_host_proof_refused",
		"secret_host_proof_refused",
		"signed",
		"secret_host_proof_refused",
	]);
});
