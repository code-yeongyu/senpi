import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { isHandoverParkedEntry } from "../../../src/modes/rpc/host-handover-parked.ts";
import { parkedEntryFromProfile, parkedOpenCommand } from "../../../src/modes/rpc/host-handover-parked-open.ts";
import { contextHost, responseData } from "../rpc-session-context-support.ts";

// senpi#7446: on one shared host, each caller's live telemetry answer decides the telemetry its own sessions
// produce. The probe reads the decision the way an exporter does: once per turn (collection) and on
// demand (delivery of what it buffered).
// The probe is also a minimal exporter: it buffers an event per turn when collection is permitted, and on
// `probe.flush` delivers the buffer to its sink only when delivery is permitted at that moment, dropping it otherwise.
const TELEMETRY_PROBE = `export default function (pi) {
	let context;
	const collected = [];
	let buffered = [];
	const sink = [];
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("turn_start", (_event, ctx) => {
		const permitted = ctx.telemetryPermitted === true;
		collected.push(permitted);
		if (permitted) buffered.push("turn");
	});
	pi.rpc.handle("probe.telemetry", () => ({ now: context?.telemetryPermitted === true, collected }));
	pi.rpc.handle("probe.flush", () => {
		const held = buffered.length;
		if (context?.telemetryPermitted === true) sink.push(...buffered);
		buffered = [];
		return { held, sink: [...sink] };
	});
}`;

const probeSchema = z.object({ now: z.boolean(), collected: z.array(z.boolean()) });
const flushSchema = z.object({ held: z.number(), sink: z.array(z.string()) });

async function hostWith(installTelemetry: boolean, onTelemetryContainmentLost?: (sessionId: string) => void) {
	const faux = fauxProvider({ api: "faux-telemetry", provider: "faux-telemetry" });
	faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("done")));
	return contextHost({
		faux,
		extension: TELEMETRY_PROBE,
		globalSettings: { enableInstallTelemetry: installTelemetry },
		...(onTelemetryContainmentLost ? { onTelemetryContainmentLost } : {}),
	});
}

type Host = Awaited<ReturnType<typeof hostWith>>;

async function permitted(host: Host, connection: string, sessionId: string): Promise<z.infer<typeof probeSchema>> {
	return probeSchema.parse(
		responseData(await host.send(connection, { type: "extension_request", name: "probe.telemetry", sessionId })),
	);
}

async function flush(host: Host, connection: string, sessionId: string): Promise<z.infer<typeof flushSchema>> {
	return flushSchema.parse(
		responseData(await host.send(connection, { type: "extension_request", name: "probe.flush", sessionId })),
	);
}

function errorCodeOf(record: Record<string, unknown> | undefined): unknown {
	return z.object({ success: z.literal(false), errorCode: z.string() }).parse(record).errorCode;
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
});

it("keeps a host opt-out when the caller grants", async () => {
	// given
	await using host = await hostWith(false);
	const sessionId = String((await host.open("desktop", { telemetry: { consent: "granted" } })).sessionId);

	// when
	await host.prompt("desktop", sessionId, "host off");

	// then
	expect(await permitted(host, "desktop", sessionId)).toEqual({ now: false, collected: [false] });
});

it("never promotes an older peer's silence to a grant", async () => {
	// given
	await using host = await hostWith(true);
	const sessionId = String((await host.open("older-peer", {})).sessionId);

	// when
	const probe = await permitted(host, "older-peer", sessionId);

	// then
	expect(probe.now).toBe(false);
});

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
});

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
	await host.router.releaseConnection("desktop");
	const afterLeaving = (await permitted(host, "cli", sessionId)).now;

	// then
	expect(attached?.success).toBe(true);
	expect([whileAttached, afterLeaving]).toEqual([false, true]);
});

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
});

it("advertises telemetry_consent, the capability a caller waits for before sending its answer", async () => {
	await using host = await contextHost();

	const info = responseData(await host.send("conn-a", { type: "get_protocol_info" }));

	expect(z.array(z.string()).parse(info.capabilities)).toContain("telemetry_consent");
});

it("refuses a malformed answer and an unattached caller with stable typed codes", async () => {
	// given
	await using host = await hostWith(true);
	const opened = await host.open("cli", { telemetry: { consent: "granted" } });
	const sessionId = String(opened.sessionId);
	const durableSessionId = String(z.object({ sessionId: z.string() }).parse(opened.state).sessionId);
	const malformed = (command: Record<string, unknown>): RpcCommand => JSON.parse(JSON.stringify(command));

	// when
	const open = await host.send(
		"conn-a",
		malformed({ type: "open_session", cwd: host.cwd, telemetry: { consent: "yes" } }),
	);
	const attach = await host.send(
		"conn-b",
		malformed({ type: "attach_session", sessionId, durableSessionId, telemetry: { consent: "yes" } }),
	);
	const live = await host.send("cli", malformed({ type: "set_telemetry_consent", sessionId, consent: "yes" }));
	const unattached = await host.send("conn-c", setConsent(sessionId, "declined"));

	// then
	expect([open, attach, live, unattached].map(errorCodeOf)).toEqual([
		"invalid_telemetry_consent",
		"invalid_telemetry_consent",
		"invalid_telemetry_consent",
		"session_not_attached",
	]);
	expect(await host.list("conn-a")).toHaveLength(1);
});

it("delivers a buffered event while delivery is permitted (positive control)", async () => {
	// given
	await using host = await hostWith(true);
	const sessionId = String((await host.open("desktop", { telemetry: { consent: "granted" } })).sessionId);
	await host.prompt("desktop", sessionId, "collected and delivered");

	// when
	const delivered = await flush(host, "desktop", sessionId);

	// then
	expect(delivered).toEqual({ held: 1, sink: ["turn"] });
});

it("drops an event buffered before a revocation instead of delivering it", async () => {
	// given
	await using host = await hostWith(true);
	const sessionId = String((await host.open("desktop", { telemetry: { consent: "granted" } })).sessionId);
	await host.prompt("desktop", sessionId, "collected before the revocation");

	// when
	await host.send("desktop", setConsent(sessionId, "declined"));
	const delivered = await flush(host, "desktop", sessionId);

	// then
	expect(delivered).toEqual({ held: 1, sink: [] });
});

it("keeps a surviving caller's grant when another attached caller's connection drops", async () => {
	// given
	await using host = await hostWith(true);
	const opened = await host.open("cli", { telemetry: { consent: "granted" }, retain_on_disconnect: true });
	const sessionId = String(opened.sessionId);
	const durableSessionId = String(z.object({ sessionId: z.string() }).parse(opened.state).sessionId);
	await host.send("desktop", {
		type: "attach_session",
		sessionId,
		durableSessionId,
		telemetry: { consent: "unanswered" },
	});
	const whileBothAttached = (await permitted(host, "cli", sessionId)).now;

	// when
	await host.router.releaseConnection("desktop");

	// then
	expect([whileBothAttached, (await permitted(host, "cli", sessionId)).now]).toEqual([false, true]);
});

it("reopens a parked session through a handover with the standing answer it parked with", async () => {
	// given
	await using host = await hostWith(true);
	const sessionPath = join(host.scratch, "parked.jsonl");
	const opened = await host.open("desktop", {
		sessionPath,
		telemetry: { consent: "granted" },
		retain_on_disconnect: true,
	});
	const sessionId = String(opened.sessionId);
	await host.send("desktop", setConsent(sessionId, "declined"));
	const parked: unknown = JSON.parse(
		JSON.stringify(parkedEntryFromProfile({ sessionPath }, host.profile(sessionId), [])),
	);
	if (!isHandoverParkedEntry(parked)) throw new Error("the parked record does not read back");
	const reopenCommand = parkedOpenCommand(parked);
	await host.send("desktop", { type: "close_session", sessionId });

	// when
	const reopened = String(responseData(await host.send("successor", reopenCommand)).sessionId);

	// then
	expect(reopenCommand.telemetry).toEqual({ consent: "declined" });
	expect((await permitted(host, "successor", reopened)).now).toBe(false);
});

it("never reaches the containment last resort on an in-process host: the session takes a revocation at once", async () => {
	// given
	const containmentLost: string[] = [];
	await using host = await hostWith(true, (id) => containmentLost.push(id));
	const sessionId = String((await host.open("desktop", { telemetry: { consent: "granted" } })).sessionId);

	// when
	const revoked = await host.send("desktop", setConsent(sessionId, "declined"));
	const afterRevoke = (await permitted(host, "desktop", sessionId)).now;

	// then
	expect([revoked?.success, afterRevoke, containmentLost]).toEqual([true, false, []]);
});
