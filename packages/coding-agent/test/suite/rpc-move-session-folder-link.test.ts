/**
 * senpi#6435: a move's folder is compared as resolved text, so a symbolic link to a checkout is another folder to the
 * move than the checkout's own path. An import that spells the folder the other way is refused. This pins that the
 * refusal is safe: it comes before anything is written, and the move stays ready for the spelling it was readied with.
 */
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const MOVE = "move-link-1";

describe("a move readied through a symbolic link to a checkout (senpi#6435)", () => {
	it("#given a move readied for a link to a checkout #when its bundle is imported into the checkout's own path #then it is refused move_fenced with nothing written, and the move still lands through the link", async () => {
		const fixture = await devices();
		const link = join(fixture.base, "link-to-b");
		symlinkSync(fixture.repoB, link, "dir");
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const identity = await move(a, { op: "identity", sessionPath: fixture.sessionPath });
		const repository = (identity.data as { repository?: unknown }).repository;
		expect(await move(b, { op: "prepare", moveId: MOVE, cwd: link, repository })).toMatchObject({ success: true });
		await hostAndRelease(a, fixture.repoA, fixture.sessionPath, MOVE);
		const sent = await move(a, { op: "export", sessionPath: fixture.sessionPath, moveId: MOVE, target: "device-b" });
		const bundleDir = (sent.data as { bundle_dir: string }).bundle_dir;
		const record = () =>
			JSON.parse(readFileSync(join(fixture.agentB, "session-moves", "ledger", `${MOVE}.json`), "utf8")) as Record<
				string,
				unknown
			>;
		const readied = record();
		expect(readied).toMatchObject({ state: "ready", cwd: link });

		const refused = await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" });

		expect(refused).toMatchObject({ success: false, errorCode: "move_fenced" });
		const sessions = getDefaultSessionDir(fixture.repoB, fixture.agentB);
		expect(existsSync(join(sessions, basename(fixture.sessionPath)))).toBe(false);
		expect(existsSync(join(sessions, ".move-staging"))).toBe(false);
		expect(record()).toEqual(readied);
		const landed = await move(b, { op: "import", bundleDir, cwd: link, from: "device-a" });
		expect(landed).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
	});
});
