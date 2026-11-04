import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	accountHost,
	closeAccountHosts,
	enrollAssignAcquire,
	envelopeOf,
	installation,
	issuer,
	offer,
	type AccountHost,
} from "./fixtures/presenter-account-host.ts";

type Adopted = Awaited<ReturnType<typeof enrollAssignAcquire>>;
interface Trigger {
	readonly trigger: string;
	readonly act: (host: AccountHost, adopted: Adopted) => void;
	readonly refusal?: string;
}

// Only the host's timers are faked, so attestation expiry is driven explicitly; sockets and crypto stay real.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	await closeAccountHosts();
	vi.useRealTimers();
});

const triggers: readonly Trigger[] = [
	{ trigger: "detach from the session", act: (host) => host.writer.detachConnectionFromSession("human", "session") },
	{ trigger: "close of the presenting connection", act: (host) => host.writer.unregisterConnection("human") },
	{ trigger: "close of the control connection", act: (_host, adopted) => adopted.peer.close() },
	{
		trigger: "a switch to another account",
		act: (host) => host.switchAccount("account-b"),
		refusal: "presenter_account_mismatch",
	},
	{ trigger: "sign-out", act: (host) => host.switchAccount(undefined), refusal: "presenter_account_unavailable" },
	{ trigger: "attestation expiry", act: () => vi.advanceTimersByTime(601_000), refusal: "attestation_expired" },
];

it.each(triggers.flatMap((trigger) => [true, false].map((presented) => ({ ...trigger, presented }))))(
	"T6: $trigger revokes an account grant (form presented: $presented)",
	async ({ act, refusal, presented }) => {
		const host = await accountHost();
		const adopted = await enrollAssignAcquire(host);
		expect(adopted.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
		const result = offer(host);
		const envelope = envelopeOf(await host.human.request());
		if (presented)
			expect(host.authority.receive(host.human.connection, { ...envelope, type: "mcp_form_presented" })).toEqual({
				ok: true,
			});
		act(host, adopted);
		expect(await result).toMatchObject(
			presented
				? { kind: "result", result: { action: "cancel" }, humanAdmission: false }
				: { kind: "processing_failure", humanAdmission: false },
		);
		expect(host.binding.capture()).toBeUndefined();
		if (refusal === undefined) return;
		expect(await adopted.peer.next()).toEqual({ type: "account_refused", version: 1, reason: refusal });
		expect(await adopted.peer.next()).toBeUndefined();
	},
);

it("T6: a re-attestation moves the expiry to the new attestedUntil", async () => {
	const host = await accountHost();
	const adopted = await enrollAssignAcquire(host);
	const exp = Math.floor(Date.now() / 1000) + 900;
	adopted.peer.send({ type: "account_reattest", attestation: issuer.mint(adopted.device.publicKey, { exp }) });
	expect(await adopted.peer.next()).toEqual({ type: "account_reattested", version: 1, attestedUntil: exp });
	vi.advanceTimersByTime(601_000);
	expect(host.binding.capture()?.ready()).toBe(true);
	vi.advanceTimersByTime(300_000);
	expect(await adopted.peer.next()).toEqual({ type: "account_refused", version: 1, reason: "attestation_expired" });
	expect(host.binding.capture()).toBeUndefined();
});

it("T4: a same-account device enrolling while another holds a presented form can neither read nor answer it", async () => {
	const host = await accountHost();
	await enrollAssignAcquire(host);
	const result = offer(host);
	const envelope = envelopeOf(await host.human.request());
	host.authority.receive(host.human.connection, { ...envelope, type: "mcp_form_presented" });
	const phone = host.presenter("phone");
	const second = await enrollAssignAcquire(host, installation(), {
		context: phone.context,
		claims: { dev: "device-b", dname: "Phone" },
	});
	expect(second.reply).toMatchObject({ type: "account_enrolled" });
	const sync = { ...envelope, type: "mcp_form_sync", dialogId: undefined, dialogToken: undefined, formRevision: undefined };
	expect(host.authority.receive(phone.connection, JSON.parse(JSON.stringify(sync)))).toEqual({
		error: "presenter_not_authorized",
	});
	const stolen = { ...envelope, type: "mcp_form_response", action: "accept", content: { value: "phone" } };
	expect(host.authority.receive(phone.connection, stolen)).toEqual({ error: "presenter_not_authorized" });
	const answer = { ...envelope, type: "mcp_form_response", action: "accept", content: { value: "laptop" } };
	expect(host.authority.receive(host.human.connection, answer)).toEqual({ ok: true });
	expect(await result).toMatchObject({
		kind: "result",
		result: { action: "accept", content: { value: "laptop" } },
		humanAdmission: true,
	});
	expect(phone.unread()).toBe(0);
});

it("T4: a form already offered to one device is never delivered to the next holder after that device leaves", async () => {
	const host = await accountHost();
	await enrollAssignAcquire(host);
	const result = offer(host);
	const envelope = envelopeOf(await host.human.request());
	host.authority.receive(host.human.connection, { ...envelope, type: "mcp_form_presented" });
	host.writer.detachConnectionFromSession("human", "session");
	expect(await result).toMatchObject({ kind: "result", result: { action: "cancel" }, humanAdmission: false });
	const phone = host.presenter("phone");
	const next = await enrollAssignAcquire(host, installation(), { context: phone.context, claims: { dev: "device-b" } });
	expect(next.acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	const own = {
		sessionId: "session",
		bindingEpoch: phone.context.bindingEpoch,
		attachmentEpoch: phone.context.attachmentEpoch,
		grantId: next.acquired?.grantId,
	};
	expect(host.authority.receive(phone.connection, { ...own, type: "mcp_form_sync" })).toEqual({ ok: true });
	const old = { dialogId: envelope.dialogId, dialogToken: envelope.dialogToken, formRevision: envelope.formRevision };
	const replay = { ...own, ...old, type: "mcp_form_response", action: "accept", content: { value: "phone" } };
	expect(host.authority.receive(phone.connection, replay)).toEqual({ error: "form_stale" });
	expect(phone.unread()).toBe(0);
});
