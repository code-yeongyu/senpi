import { afterEach, expect, it, vi } from "vitest";
import {
	accountHost,
	closeAccountHosts,
	enroll,
	enrollAssignAcquire,
	installation,
	issuer,
	signedCommand,
	type AccountHost,
} from "./fixtures/presenter-account-host.ts";

afterEach(async () => {
	await closeAccountHosts();
	vi.useRealTimers();
});

const assign = (host: AccountHost) => ({
	type: "mcp_presenter_assign",
	id: "assign",
	sessionId: "session",
	bindingEpoch: host.binding.epoch,
	purpose: "mcp_form",
});
const acquire = (context: AccountHost["context"]) => ({
	type: "mcp_presenter_acquire",
	id: "acquire",
	...context,
	sessionId: "session",
	kind: "desktop",
	purpose: "mcp_form",
});

async function enrolled(host: AccountHost) {
	const device = installation();
	const peer = host.open();
	const { reply } = await enroll(peer, device, issuer.mint(device.publicKey));
	expect(reply).toMatchObject({ type: "account_enrolled" });
	const command = (value: object) => signedCommand(peer, reply?.principalId, device.privateKey, value);
	return { peer, command };
}

const lapses = [
	{ lapse: "the host is now signed into another account", reason: "presenter_account_mismatch" },
	{ lapse: "the host is now signed out", reason: "presenter_account_unavailable" },
	{ lapse: "the attestation is past attestedUntil", reason: "attestation_expired" },
] as const;

it.each(lapses.flatMap((lapse) => (["assign", "acquire"] as const).map((stage) => ({ ...lapse, stage }))))(
	"$stage is refused and the account principal revoked when $lapse, with no change event or timer",
	async ({ reason, stage }) => {
		// Date is faked so attestedUntil can pass while the host's expiry timer never runs.
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const host = await accountHost();
		const { peer, command } = await enrolled(host);
		if (stage === "acquire") expect(await command(assign(host))).toMatchObject({ type: "mcp_presenter_assigned" });
		if (reason === "presenter_account_mismatch") host.state.account = "account-b";
		else if (reason === "presenter_account_unavailable") host.state.account = undefined;
		else vi.setSystemTime(Date.now() + 601_000);
		const refused = await command(stage === "assign" ? assign(host) : acquire(host.context));
		expect(refused).toEqual({ type: "account_refused", version: 1, reason });
		expect(await peer.next()).toBeUndefined();
		expect(host.binding.capture()).toBeUndefined();
	},
);

it("T8: a re-bind fences the account principal's earlier assignment and grant", async () => {
	const host = await accountHost();
	const adopted = await enrollAssignAcquire(host);
	host.writer.bindMcpForms("session", "durable", {}, () => {});
	expect(host.binding.capture()).toBeUndefined();
	const rebound = host.authority.connectionContext(host.human.connection, "session");
	if (!rebound) throw new Error("The re-bound session lost its attachment");
	expect(rebound.bindingEpoch).not.toBe(host.context.bindingEpoch);
	const again = await signedCommand(adopted.peer, adopted.principalId, adopted.device.privateKey, acquire(rebound));
	expect(again).toMatchObject({ type: "mcp_presenter_error", id: "acquire" });
	expect(host.writer.getMcpFormBinding("session")?.capture()).toBeUndefined();
});

it("T8: re-enrolling the same device and key fences the earlier assignment", async () => {
	const host = await accountHost();
	const first = await enrollAssignAcquire(host);
	const peer = host.open();
	const second = await enroll(peer, first.device, issuer.mint(first.device.publicKey));
	const reacquire = await signedCommand(peer, second.reply?.principalId, first.device.privateKey, acquire(host.context));
	expect(reacquire).toMatchObject({ type: "mcp_presenter_error", id: "acquire" });
	expect(host.binding.capture()).toBeUndefined();
});

it("T8: an account principal of one host incarnation cannot act on its successor", async () => {
	const first = await accountHost();
	const adopted = await enrollAssignAcquire(first);
	const successor = await accountHost();
	const command = assign(successor);
	expect(await signedCommand(successor.open(), adopted.principalId, adopted.device.privateKey, command)).toBeUndefined();
	expect(successor.binding.capture()).toBeUndefined();
});
