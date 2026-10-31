import { expect, it } from "vitest";
import { attachmentRig } from "./rpc-attachment-support.ts";

// senpi#3795: an adopter's own holds are not "attached elsewhere".
it.each([1, 3])("releases without force with %i caller attachments", async (holds) => {
	await using rig = await attachmentRig();
	const ref = await rig.session(holds);
	expect(
		await rig.send("caller", {
			id: "release",
			type: "release_session",
			sessionId: ref.sessionId,
			reason: "takeover",
		}),
	).toMatchObject({ success: true, data: { released: true } });
	expect(await rig.list()).toEqual([]);
});

it("refuses another connection's holds unless force and notifies that connection", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session(2);
	await rig.open("other", { cwd: rig.dir, sessionPath: ref.sessionPath });
	expect(
		await rig.send("caller", {
			id: "refused",
			type: "release_session",
			sessionId: ref.sessionId,
			reason: "takeover",
		}),
	).toMatchObject({ success: false, error: "attached", errorData: { attachments: 1 } });
	expect(
		await rig.send("caller", {
			id: "force",
			type: "release_session",
			sessionId: ref.sessionId,
			reason: "takeover",
			force: true,
		}),
	).toMatchObject({ success: true });
	expect(rig.recordsFor("other")).toContainEqual(
		expect.objectContaining({
			type: "session_closed",
			sessionId: ref.sessionId,
			reason: "released",
		}),
	);
});
