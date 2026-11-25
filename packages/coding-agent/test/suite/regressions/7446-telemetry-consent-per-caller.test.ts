import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { z } from "zod";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { contextHost, responseData } from "../rpc-session-context-support.ts";

// senpi#7446: on one shared host, each caller's live telemetry answer decides the telemetry its own sessions
// produce. The probe reads the decision the way an exporter does: once per turn (collection) and on
// demand (delivery of what it buffered).
const TELEMETRY_PROBE = `export default function (pi) {
	let context;
	const collected = [];
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("turn_start", (_event, ctx) => { collected.push(ctx.telemetryPermitted === true); });
	pi.rpc.handle("probe.telemetry", () => ({ now: context?.telemetryPermitted === true, collected }));
}`;

const probeSchema = z.object({ now: z.boolean(), collected: z.array(z.boolean()) });

async function hostWith(installTelemetry: boolean) {
	const faux = fauxProvider({ api: "faux-telemetry", provider: "faux-telemetry" });
	faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("done")));
	return contextHost({
		faux,
		extension: TELEMETRY_PROBE,
		globalSettings: { enableInstallTelemetry: installTelemetry },
	});
}

type Host = Awaited<ReturnType<typeof hostWith>>;

async function permitted(host: Host, connection: string, sessionId: string): Promise<z.infer<typeof probeSchema>> {
	return probeSchema.parse(
		responseData(await host.send(connection, { type: "extension_request", name: "probe.telemetry", sessionId })),
	);
}

function setConsent(sessionId: string, consent: "granted" | "declined" | "unanswered"): RpcCommand {
	return { type: "set_telemetry_consent", sessionId, consent };
}

it("goes from unanswered to granted to revoked in one live session without restarting the host", async () => {
	// given
	await using host = await hostWith(true);
	const sessionId = String((await host.open("desktop", { telemetry: { consent: "unanswered" } })).sessionId);

	// when
	const unanswered = (await permitted(host, "desktop", sessionId)).now;
	const granted = await host.send("desktop", setConsent(sessionId, "granted"));
	const afterGrant = (await permitted(host, "desktop", sessionId)).now;
	await host.prompt("desktop", sessionId, "collected while granted");
	const revoked = await host.send("desktop", setConsent(sessionId, "declined"));
	const afterRevoke = await permitted(host, "desktop", sessionId);

	// then
	expect([granted?.success, revoked?.success]).toEqual([true, true]);
	expect([unanswered, afterGrant, afterRevoke.now]).toEqual([false, true, false]);
	expect(afterRevoke.collected).toEqual([true]);
}, 120_000);

it("keeps a host opt-out when the caller grants", async () => {
	// given
	await using host = await hostWith(false);
	const sessionId = String((await host.open("desktop", { telemetry: { consent: "granted" } })).sessionId);

	// when
	await host.prompt("desktop", sessionId, "host off");

	// then
	expect(await permitted(host, "desktop", sessionId)).toEqual({ now: false, collected: [false] });
}, 120_000);

it("never promotes an older peer's silence to a grant", async () => {
	// given
	await using host = await hostWith(true);
	const sessionId = String((await host.open("older-peer", {})).sessionId);

	// when
	const probe = await permitted(host, "older-peer", sessionId);

	// then
	expect(probe.now).toBe(false);
}, 120_000);

it("lets two callers on one host process answer only for their own sessions", async () => {
	// given
	await using host = await hostWith(true);
	const cli = String((await host.open("cli", { telemetry: { consent: "granted" } })).sessionId);
	const desktop = String((await host.open("desktop", { telemetry: { consent: "granted" } })).sessionId);

	// when
	await host.send("desktop", setConsent(desktop, "declined"));
	const foreign = await host.send("desktop", setConsent(cli, "declined"));

	// then
	expect(foreign?.success).toBe(false);
	expect((await permitted(host, "cli", cli)).now).toBe(true);
	expect((await permitted(host, "desktop", desktop)).now).toBe(false);
}, 120_000);

it("lets an attached caller's decline hold a shared session off until it leaves", async () => {
	// given
	await using host = await hostWith(true);
	const opened = await host.open("cli", { telemetry: { consent: "granted" }, retain_on_disconnect: true });
	const sessionId = String(opened.sessionId);
	const durableSessionId = String(z.object({ sessionId: z.string() }).parse(opened.state).sessionId);

	// when
	const attached = await host.send("desktop", {
		type: "attach_session",
		sessionId,
		durableSessionId,
		telemetry: { consent: "declined" },
	});
	const whileAttached = (await permitted(host, "cli", sessionId)).now;
	await host.send("desktop", { type: "release_attachment", sessionId });
	const afterLeaving = (await permitted(host, "cli", sessionId)).now;

	// then
	expect(attached?.success).toBe(true);
	expect([whileAttached, afterLeaving]).toEqual([false, true]);
}, 120_000);

it("keeps a deliberate revocation after the revoking opener leaves, until a caller grants on purpose", async () => {
	// given
	await using host = await hostWith(true);
	const opened = await host.open("desktop", { telemetry: { consent: "granted" }, retain_on_disconnect: true });
	const sessionId = String(opened.sessionId);
	const durableSessionId = String(z.object({ sessionId: z.string() }).parse(opened.state).sessionId);
	await host.send("desktop", setConsent(sessionId, "declined"));

	// when
	await host.send("desktop", { type: "release_attachment", sessionId });
	await host.send("observer", {
		type: "attach_session",
		sessionId,
		durableSessionId,
		telemetry: { consent: "granted" },
	});
	const attachedOnly = (await permitted(host, "observer", sessionId)).now;
	await host.send("observer", setConsent(sessionId, "granted"));
	const grantedOnPurpose = (await permitted(host, "observer", sessionId)).now;

	// then
	expect([attachedOnly, grantedOnPurpose]).toEqual([false, true]);
}, 120_000);

it("advertises telemetry_consent, the capability a caller waits for before sending its answer", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(z.array(z.string()).parse(info.capabilities)).toContain("telemetry_consent");
}, 120_000);

it("refuses an answer outside granted, declined and unanswered", async () => {
	await using host = await contextHost();

	const refused = await host.openFailure("conn-a", { telemetry: { consent: "yes" } });

	expect(refused).toContain("telemetry");
	expect(await host.list("conn-a")).toEqual([]);
}, 120_000);
