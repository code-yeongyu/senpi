/**
 * senpi#6267 follow-up (P1): `release_session` with reason `move` takes an export request and answers the export's
 * data beside the release answer, so a move away from this host costs one round trip instead of two. The export runs
 * after the release, through the one function `move_session export` uses, so the two answer the same data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, move, type Rig } from "./rpc-move-session-support.ts";

const MOVE = "move-release-1";

type Fixture = Awaited<ReturnType<typeof devices>>;

/** The release the caller sends for a move: the session is hosted, then released with an export request. */
async function releaseForMove(
	rig: Rig,
	fixture: Fixture,
	exportRequest?: { readonly inline?: true; readonly inlineMaxBytes?: number },
): Promise<Record<string, unknown> & { readonly handle: string }> {
	const session = opened(
		await rig.open("conn-a", { cwd: fixture.repoA, sessionPath: fixture.sessionPath, retain_on_disconnect: true }),
		0,
	);
	await rig.drop("conn-a");
	return releaseHandle(rig, session.sessionId, exportRequest);
}

/** A release on a handle the caller already has: the same request sent again goes through this. */
async function releaseHandle(
	rig: Rig,
	sessionId: string,
	exportRequest?: { readonly inline?: true; readonly inlineMaxBytes?: number },
): Promise<Record<string, unknown> & { readonly handle: string }> {
	const released = await rig.router.handle({
		type: "release_session",
		id: "rel",
		sessionId,
		reason: "move",
		moveId: MOVE,
		target: "device-b",
		...(exportRequest === undefined ? {} : { export: exportRequest }),
	});
	await rig.settle();
	if (released === undefined) throw new Error("release_session answered nothing");
	return { ...released, handle: sessionId };
}

const exportOf = (released: Record<string, unknown>) =>
	(released.data as { export?: { ok?: boolean; data?: Record<string, unknown>; error?: string } }).export;

const releasedFields = (released: Record<string, unknown>) => {
	const { export: _export, ...rest } = released.data as Record<string, unknown>;
	return rest;
};

const manifestOf = (bundleDir: string) => readFileSync(join(bundleDir, "manifest.json"), "utf8");

describe("release_session reason move answers the export (senpi#6267 P1)", () => {
	it("#given a session hosted for a move #when the release carries an export request #then it answers the export's data, the same data move_session export answers, and the file holds one seal", async () => {
		const fixture = await devices();
		const a = createInProcessRig(fixture.agentA);

		const released = await releaseForMove(a, fixture, { inline: true });

		const answered = exportOf(released);
		expect(released.success).toBe(true);
		expect(answered?.ok).toBe(true);
		const again = await move(a, {
			op: "export",
			sessionPath: fixture.sessionPath,
			moveId: MOVE,
			target: "device-b",
			inline: true,
		});
		expect(answered?.data).toEqual(again.data);
		expect(customTypes(fixture.sessionPath)).toEqual(["session_released"]);
	});

	it("#given a bundle that fits the cap #then the answered export carries every file of the bundle folder, the manifest first", async () => {
		const fixture = await devices();
		const a = createInProcessRig(fixture.agentA);

		const released = await releaseForMove(a, fixture, { inline: true });

		const data = exportOf(released)?.data as {
			bundle_dir: string;
			files: number;
			inline_files?: Array<{ path: string; sha256: string; base64: string }>;
		};
		expect(data.inline_files?.map((file) => file.path)[0]).toBe("manifest.json");
		// `files` counts the bundle's own files; `inline_files` carries the manifest ahead of them.
		expect(data.inline_files?.length).toBe(data.files + 1);
		const manifest = data.inline_files?.find((file) => file.path === "manifest.json");
		expect(Buffer.from(manifest?.base64 ?? "", "base64").toString("utf8")).toBe(manifestOf(data.bundle_dir));
	});

	it("#given a bundle over the asked limit #then the answered export is the folder answer alone", async () => {
		const fixture = await devices();
		const a = createInProcessRig(fixture.agentA);

		const released = await releaseForMove(a, fixture, { inline: true, inlineMaxBytes: 10 });

		expect(Object.keys(exportOf(released)?.data ?? {}).sort()).toEqual([
			"bundle_dir",
			"files",
			"move_id",
			"session_id",
		]);
	});

	it("#given a release that asks for no export #then its answer is the one it gives today", async () => {
		const fixture = await devices();
		const a = createInProcessRig(fixture.agentA);

		const released = await releaseForMove(a, fixture);

		expect(exportOf(released)).toBeUndefined();
		expect(Object.keys(released.data as object).sort()).toEqual([
			"attachments",
			"dropped",
			"released",
			"session_path",
		]);
	});

	it("#given a release that answered its export #when the same release is sent again #then the handle is gone and the bundle it wrote is untouched", async () => {
		const fixture = await devices();
		const a = createInProcessRig(fixture.agentA);
		const released = await releaseForMove(a, fixture, { inline: true });
		const data = exportOf(released)?.data as { bundle_dir: string };
		const wrote = manifestOf(data.bundle_dir);

		const again = await releaseHandle(a, released.handle, { inline: true });

		expect(again.success).toBe(false);
		expect(again.error).toBe("unknown_session");
		expect(manifestOf(data.bundle_dir)).toBe(wrote);
		expect(releasedFields(released)).toEqual({
			released: true,
			session_path: fixture.sessionPath,
			attachments: 0,
			dropped: { deliveries: [], user_messages: [] },
		});
	});
});
