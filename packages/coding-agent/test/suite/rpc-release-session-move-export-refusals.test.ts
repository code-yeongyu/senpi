/**
 * senpi#6267 (P1): an export request a release cannot meet is refused before anything is interrupted, staged or
 * sealed, so the session is still open, still queued and still writable afterwards. The check sits right after the
 * reason check, so it answers whatever else the host is doing.
 */
import { describe, expect, it } from "vitest";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, type Rig } from "./rpc-move-session-support.ts";

const MOVE = "move-refused-1";

type Fixture = Awaited<ReturnType<typeof devices>>;

/** The release as a client could send it, with any `export` value: the host's own parse is what must refuse it. */
async function releaseWith(
	rig: Rig,
	sessionId: string,
	fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const command = { type: "release_session", id: "rel", sessionId, reason: "move", moveId: MOVE, ...fields };
	const released = await rig.router.handle(command as Parameters<Rig["router"]["handle"]>[0]);
	await rig.settle();
	if (released === undefined) throw new Error("release_session answered nothing");
	return { ...released };
}

async function hosted(fixture: Fixture, rig: Rig): Promise<string> {
	const session = opened(
		await rig.open("conn-a", { cwd: fixture.repoA, sessionPath: fixture.sessionPath, retain_on_disconnect: true }),
		0,
	);
	await rig.drop("conn-a");
	return session.sessionId;
}

describe("a release that cannot export is refused before it seals (senpi#6267 P1)", () => {
	it.each<[string, Record<string, unknown>]>([
		["an export on a takeover release", { reason: "takeover", export: { inline: true }, target: "device-b" }],
		["an export that is not an object", { export: "yes", target: "device-b" }],
		["an export with a list in its place", { export: [], target: "device-b" }],
		["an export with no target to move to", { export: { inline: true } }],
		["an export with a blank target", { export: { inline: true }, target: "   " }],
		["an inline flag that is not true", { export: { inline: false }, target: "device-b" }],
		["a negative inlineMaxBytes", { export: { inline: true, inlineMaxBytes: -1 }, target: "device-b" }],
		["a fractional inlineMaxBytes", { export: { inline: true, inlineMaxBytes: 1.5 }, target: "device-b" }],
	])(
		"#given a session hosted for a move #when the release carries %s #then it is refused invalid_move_request and the session is untouched",
		async (_name, fields) => {
			const fixture = await devices();
			const a = createInProcessRig(fixture.agentA);
			const sessionId = await hosted(fixture, a);

			const released = await releaseWith(a, sessionId, fields);

			expect(released).toMatchObject({ success: false, errorCode: "invalid_move_request" });
			expect(customTypes(fixture.sessionPath)).toEqual([]);
			expect((await a.list()).map((row) => row.sessionId)).toEqual([sessionId]);
		},
	);
});
