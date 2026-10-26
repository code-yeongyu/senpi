import { expect, it } from "vitest";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { attachmentWireResponse } from "./rpc-attachment-wire-schema.ts";

it("validates every attachment and capability response against wire contract v1.1", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const responses: unknown[] = [];
	responses.push(await rig.send("caller", { id: "protocol", type: "get_protocol_info" }));
	responses.push(await rig.send("other", { id: "unknown", type: "attach_session", ...ref, sessionId: "gone" }));
	responses.push(
		await rig.send("other", { id: "identity", type: "attach_session", ...ref, durableSessionId: "stale" }),
	);
	responses.push(await rig.send("other", { id: "attach", type: "attach_session", ...ref }));
	// No caller connection: host-internal calls reach the attachment commands without one.
	responses.push(await rig.router.handle({ id: "attach-unowned", type: "attach_session", ...ref }));
	responses.push(await rig.router.handle({ id: "reclaim-unowned", type: "reclaim_session", ...ref }));
	responses.push(await rig.send("caller", { id: "foreign", type: "reclaim_session", ...ref }));
	responses.push(
		await rig.send("caller", {
			id: "foreign-release",
			type: "release_session",
			sessionId: ref.sessionId,
			reason: "takeover",
		}),
	);
	responses.push(await rig.send("other", { id: "release", type: "release_attachment", sessionId: ref.sessionId }));
	responses.push(await rig.send("other", { id: "no-hold", type: "release_attachment", sessionId: ref.sessionId }));
	responses.push(await rig.send("caller", { id: "reclaim", type: "reclaim_session", ...ref }));
	responses.push(await rig.send("caller", { id: "gone", type: "reclaim_session", ...ref }));
	const release = await rig.session();
	responses.push(
		await rig.send("caller", {
			id: "handoff",
			type: "release_session",
			sessionId: release.sessionId,
			reason: "takeover",
		}),
	);
	// Do not hide unsolicited responses emitted while a command finalizes.
	responses.push(...rig.records().filter((record) => record.type === "response" && record.command !== "open_session"));
	expect(responses.length).toBeGreaterThanOrEqual(13);
	for (const response of responses) {
		const parsed = attachmentWireResponse.safeParse(response);
		expect(parsed.success, JSON.stringify({ response, issues: parsed.error?.issues })).toBe(true);
	}
});
