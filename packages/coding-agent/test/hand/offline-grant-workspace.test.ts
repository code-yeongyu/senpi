// S27b (brain/hand split, R14.b): a call's workspace is resolved by the hand from its own configured roots, by canonical
// path and whole path components; a root it cannot place is refused, and the scope opens on the canonical root.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grant, grantHarness, outcome, snapshotOf } from "./offline-grant-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

const dirs: string[] = [];
afterEach(async () => {
	await cleanupHands();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): { readonly ws: string; readonly ws2: string; readonly outside: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "senpi-s27b-ws-")));
	dirs.push(base);
	const ws = join(base, "ws");
	const ws2 = join(base, "ws2");
	const outside = join(base, "outside");
	for (const dir of [ws, ws2, outside, join(ws, "sub")]) mkdirSync(dir);
	symlinkSync(outside, join(ws, "escape"));
	return { ws, ws2, outside };
}

async function replyFor(
	root: string,
	configured: string,
	label?: string,
): Promise<{ reply: string; opened: string[] }> {
	const hand = grantHarness({
		workspaces: [{ root: configured, ...(label === undefined ? {} : { label }) }],
		snapshot: snapshotOf([grant({ workspace: label ?? "omo" })]),
	});
	await hand.invoke(root);
	const [reply] = await hand.frameCount(1);
	return { reply: outcome(reply), opened: hand.opened };
}

describe("the hand places a call's root in one of its own workspaces (S27b)", () => {
	it("accepts a root inside a configured workspace, under the default label omo", async () => {
		const { ws } = scratch();

		expect(await replyFor(join(ws, "sub"), ws)).toEqual({ reply: "settled", opened: [join(ws, "sub")] });
	});

	it("checks the grant for the label the configured root carries", async () => {
		const { ws } = scratch();

		expect((await replyFor(ws, ws, "project-a")).reply).toBe("settled");
	});

	it.each([
		["a sibling whose name only starts like the workspace", "ws2"],
		["a directory outside every workspace", "outside"],
		["a symlink inside the workspace that escapes it", "escape"],
		["a root that does not exist", "missing"],
	])("refuses %s as workspace_unknown, and keeps serving", async (_label, which) => {
		const { ws, ws2, outside } = scratch();
		const root = { ws2, outside, escape: join(ws, "escape"), missing: join(ws, "missing") }[which] ?? ws;
		const hand = grantHarness({ workspaces: [{ root: ws }], snapshot: snapshotOf([grant()]) });

		await hand.invoke(root);
		await hand.invoke(ws);
		const replies = (await hand.frameCount(2)).map(outcome);

		expect(replies).toEqual(["refused:workspace_unknown", "settled"]);
		expect(hand.opened).toEqual([ws]);
	});

	it("opens the scope on the canonical root, not the path the call named", async () => {
		const { ws } = scratch();
		const named = join(ws, "sub", "..", "sub");

		expect(await replyFor(named, ws)).toEqual({ reply: "settled", opened: [join(ws, "sub")] });
	});
});
