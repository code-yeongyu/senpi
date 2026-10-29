import { join } from "node:path";
import { expect, it } from "vitest";
import { contextHost, responseData } from "./rpc-session-context-support.ts";

// #4728: observe contexts the real transport supplies, never fabricate them in a mock.
const extension = `export default function (pi) {
	const contexts = new Map();
	pi.rpc.handle("probe.owner", (_data, context) => {
		if (!context) return { supported: false };
		contexts.set(context.ownerId, context);
		return {
			supported: true,
			ownerId: context.ownerId,
			aborted: context.disconnectSignal.aborted,
			contexts: [...contexts.values()].map(item => ({
				ownerId: item.ownerId,
				aborted: item.disconnectSignal.aborted,
			})),
		};
	});
}`;

it("isolates real connection owners despite identical caller-supplied ownership data", async () => {
	// Given: two real host attachments to one session and one extension closure.
	await using host = await contextHost({ extension });
	const sessionPath = join(host.scratch, "shared.jsonl");
	const opened = await host.open("client-a", { sessionPath });
	const sessionId = String(opened.sessionId);
	await host.open("client-b", { sessionPath });
	const request = {
		type: "extension_request" as const,
		sessionId,
		name: "probe.owner",
		data: { ownerId: "spoofed", sessionId: "spoofed", disconnectSignal: {} },
	};

	// When: both callers supply the same forged identity, then A calls again.
	const a = responseData(await host.send("client-a", request));
	const b = responseData(await host.send("client-b", request));
	const again = responseData(await host.send("client-a", request));

	// Then: ownership is transport-derived, stable after return, and different for B.
	expect(a.supported).toBe(true);
	expect(b.supported).toBe(true);
	expect(a.ownerId).toEqual(expect.any(String));
	expect(a.ownerId).not.toBe("spoofed");
	expect(b.ownerId).not.toBe(a.ownerId);
	expect(again.ownerId).toBe(a.ownerId);
	expect(again.aborted).toBe(false);
}, 120_000);

it("aborts only the departed owner's context while another attachment keeps the session alive", async () => {
	// Given: the extension retained contexts after both requests returned.
	await using host = await contextHost({ extension });
	const sessionPath = join(host.scratch, "retained.jsonl");
	const opened = await host.open("client-a", { sessionPath });
	const sessionId = String(opened.sessionId);
	await host.open("client-b", { sessionPath });
	const request = { type: "extension_request" as const, sessionId, name: "probe.owner" };
	const a = responseData(await host.send("client-a", request));
	const b = responseData(await host.send("client-b", request));
	expect(a.supported).toBe(true);
	expect(b.supported).toBe(true);

	// When: the host releases A, without disposing B's session.
	await host.router.releaseConnection("client-a");
	const after = responseData(await host.send("client-b", request));

	// Then: the captured lifetime is retired immediately, not whichever caller is current.
	expect(after.ownerId).toBe(b.ownerId);
	expect(after.contexts).toEqual([
		{ ownerId: a.ownerId, aborted: true },
		{ ownerId: b.ownerId, aborted: false },
	]);
}, 120_000);
