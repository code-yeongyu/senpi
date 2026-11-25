import { afterEach, expect, it, vi } from "vitest";
import type { TelemetryCallersVerdict } from "../../../src/core/telemetry-consent.ts";
import { retainHost } from "../rpc-retain-on-disconnect-support.ts";

// senpi#7446 H1: a worker session's telemetry change is acknowledged only once the worker confirmed the verdict. A
// change the worker refused is not kept and is answered with a typed refusal; an attach whose answer was refused is
// undone, so no caller ends up attached to a session whose policy the host cannot prove.

afterEach(() => {
	vi.restoreAllMocks();
});

type Host = Awaited<ReturnType<typeof retainHost>>;

function verdictsSent(host: Host): TelemetryCallersVerdict[] {
	return host.posted.flatMap(({ message }) => (message.type === "telemetry_callers" ? [message.verdict] : []));
}

async function openGranted(host: Host): Promise<{ sessionId: string; durableSessionId: string }> {
	const opened = await host.open("desktop", { retain_on_disconnect: true, telemetry: { consent: "granted" } });
	const sessionId = String((opened?.data as { sessionId?: string } | undefined)?.sessionId);
	const listed = host.registry.peek(sessionId)?.worker?.snapshot?.state.sessionId;
	if (listed === undefined) throw new Error("worker session has no durable id");
	return { sessionId, durableSessionId: listed };
}

it("refuses a revocation the worker did not confirm, keeping its confirmed verdict, and applies it once confirmed", async () => {
	// given
	await using host = await retainHost();
	const { sessionId } = await openGranted(host);
	host.telemetryUpdates.refuse = true;

	// when
	const refused = await host.send("desktop", { type: "set_telemetry_consent", sessionId, consent: "declined" });
	const keptAfterRefusal = host.registry.peek(sessionId)?.telemetry?.confirmed;
	host.telemetryUpdates.refuse = false;
	const applied = await host.send("desktop", { type: "set_telemetry_consent", sessionId, consent: "declined" });

	// then
	expect([refused?.success, refused?.errorCode]).toEqual([false, "telemetry_update_unconfirmed"]);
	expect(keptAfterRefusal).toEqual({ events: true, attribution: true });
	expect(applied?.success).toBe(true);
	expect(host.registry.peek(sessionId)?.telemetry?.confirmed).toEqual({ events: false, attribution: false });
	expect(verdictsSent(host).at(-1)).toEqual({ events: false, attribution: false });
});

it("undoes an attach whose telemetry answer the worker did not confirm", async () => {
	// given
	await using host = await retainHost();
	const { sessionId, durableSessionId } = await openGranted(host);
	host.telemetryUpdates.refuse = true;

	// when
	const attached = await host.send("observer", {
		type: "attach_session",
		sessionId,
		durableSessionId,
		telemetry: { consent: "declined" },
	});

	host.telemetryUpdates.refuse = false;
	const answeredAfterwards = await host.send("observer", {
		type: "set_telemetry_consent",
		sessionId,
		consent: "declined",
	});

	// then
	expect([attached?.success, attached?.errorCode]).toEqual([false, "telemetry_update_unconfirmed"]);
	expect(answeredAfterwards?.errorCode).toBe("session_not_attached");
	expect(host.registry.peek(sessionId)?.telemetry?.confirmed).toEqual({ events: true, attribution: true });
});
