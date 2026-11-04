import { afterEach, expect, it } from "vitest";
import {
	accountHost,
	claimsOf,
	closeAccountHosts,
	connectedPair,
	enroll,
	enrollAssignAcquire,
	installation,
	issuer,
	signedCommand,
} from "./fixtures/presenter-account-host.ts";
import { enrollmentKey, enrollmentPeer, enrollmentProof, enrollmentRequest } from "./fixtures/presenter-enrollment.ts";

afterEach(closeAccountHosts);

const nowS = () => Math.floor(Date.now() / 1000);

it("T7: an account principal's commands never make it a launch owner", async () => {
	const host = await accountHost();
	const adopted = await enrollAssignAcquire(host);
	expect(adopted.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	expect(host.control.successorBootstrapProvider()).toBeUndefined();
});

it("T7: with an inherited owner, a later account command leaves the successor permit with that owner", async () => {
	const { hostSide, peerSide } = await connectedPair();
	const host = await accountHost({ inheritedBootstrap: hostSide });
	const bootstrap = enrollmentPeer(peerSide);
	bootstrap.send(enrollmentRequest());
	bootstrap.send(enrollmentProof((await bootstrap.next())?.transcript));
	const enrolled = await bootstrap.next();
	expect(enrolled).toMatchObject({ type: "enrolled" });
	const owner = host.open();
	const ownerAssign = await signedCommand(owner, enrolled?.principalId, enrollmentKey.privateKey, {
		type: "mcp_presenter_assign",
		sessionId: "session",
		bindingEpoch: host.binding.epoch,
		purpose: "mcp_form",
	});
	expect(ownerAssign).toMatchObject({ type: "mcp_presenter_assigned" });
	const adopted = await enrollAssignAcquire(host);
	expect(adopted.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	void host.control.successorBootstrap();
	expect(await owner.next()).toMatchObject({ type: "mcp_presenter_successor_prepare" });
	const probe = await signedCommand(adopted.peer, adopted.principalId, adopted.device.privateKey, {
		type: "mcp_presenter_revoke",
		id: "probe",
		registrationId: "none",
	});
	expect(probe).toMatchObject({ type: "mcp_presenter_error", id: "probe" });
});

it("T11: a fresh attestation for the same key and account extends attestedUntil", async () => {
	const host = await accountHost();
	const adopted = await enrollAssignAcquire(host);
	const exp = nowS() + 900;
	adopted.peer.send({ type: "account_reattest", attestation: issuer.mint(adopted.device.publicKey, { exp }) });
	expect(await adopted.peer.next()).toEqual({ type: "account_reattested", version: 1, attestedUntil: exp });
	expect(exp).not.toBe(claimsOf(adopted.token).exp);
	expect(host.binding.capture()?.ready()).toBe(true);
});

it("T11: a re-attestation with a used jti is refused and the principal keeps its grant", async () => {
	const host = await accountHost();
	const adopted = await enrollAssignAcquire(host);
	adopted.peer.send({ type: "account_reattest", attestation: adopted.token });
	expect(await adopted.peer.next()).toEqual({ type: "account_refused", version: 1, reason: "attestation_replayed" });
	expect(host.binding.capture()?.ready()).toBe(true);
	const fresh = issuer.mint(adopted.device.publicKey);
	adopted.peer.send({ type: "account_reattest", attestation: fresh });
	expect(await adopted.peer.next()).toMatchObject({ type: "account_reattested" });
});

it.each([
	{
		name: "another key",
		reason: "attestation_key_mismatch",
		hostAccount: "account-a",
		acc: "account-a",
		otherKey: true,
	},
	{
		name: "the host now signed into another account",
		reason: "presenter_account_mismatch",
		hostAccount: "account-b",
		acc: "account-a",
		otherKey: false,
	},
	{
		name: "a token of the host's new account",
		reason: "presenter_account_mismatch",
		hostAccount: "account-b",
		acc: "account-b",
		otherKey: false,
	},
])(
	"T11: a re-attestation with $name is refused and revokes the principal",
	async ({ reason, hostAccount, acc, otherKey }) => {
		const host = await accountHost();
		const adopted = await enrollAssignAcquire(host);
		expect(host.binding.capture()?.ready()).toBe(true);
		host.state.account = hostAccount;
		const key = otherKey ? installation().publicKey : adopted.device.publicKey;
		adopted.peer.send({ type: "account_reattest", attestation: issuer.mint(key, { acc }) });
		expect(await adopted.peer.next()).toEqual({ type: "account_refused", version: 1, reason });
		expect(await adopted.peer.next()).toBeUndefined();
		expect(host.binding.capture()).toBeUndefined();
		const again = host.open();
		const command = { type: "mcp_presenter_revoke", id: "after", registrationId: "none" };
		expect(await signedCommand(again, adopted.principalId, adopted.device.privateKey, command)).toBeUndefined();
	},
);

it("re-enrolling the same device and key supersedes the earlier principal and revokes its grant", async () => {
	const host = await accountHost();
	const first = await enrollAssignAcquire(host);
	expect(host.binding.capture()?.ready()).toBe(true);
	const second = await enroll(host.open(), first.device, issuer.mint(first.device.publicKey));
	expect(second.reply).toMatchObject({ type: "account_enrolled" });
	expect(second.reply?.principalId).not.toBe(first.principalId);
	expect(await first.peer.next()).toBeUndefined();
	expect(host.binding.capture()).toBeUndefined();
});
