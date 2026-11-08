import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rawClient } from "../rpc-raw-socket-client.ts";
import { dataOf, notifiedAfter, openFauxSession, permissionModeHost, replyOf } from "../rpc-permission-mode-support.ts";

// Remote approval-mode work (tracked privately): a task runner forwarding a child's permission prompt needs the parent's effective
// mode and a way to ask every client attached to the parent session, not the connection whose command is running
// (a background child raises its prompt after that command returned).

describe("#6189 permission mode for extensions", () => {
	it("announces a live preset change on permission_preset_changed and getPermissionPreset reads it", async () => {
		const host = await permissionModeHost();
		try {
			const client = await rawClient(host.socketPath);
			const { sessionId } = await openFauxSession(client, host.cwd, { permissionPreset: "full-access" });
			dataOf(await client.request({ type: "set_permission_preset", sessionId, permissionPreset: "ask" }));

			const before = client.records.length;
			client.send({ type: "prompt", sessionId, message: "/mode-probe" });
			const probe: unknown = JSON.parse(await notifiedAfter(client, sessionId, "mode-probe:", before));
			expect(probe).toEqual({ getter: "ask", changes: ["ask"] });
			client.close();
		} finally {
			await host.dispose();
		}
	}, 600_000);

	it("raises a session dialog on every attached connection; the first answer wins, a later one is already_answered", async () => {
		const host = await permissionModeHost();
		try {
			const first = await rawClient(host.socketPath);
			const second = await rawClient(host.socketPath);
			const sessionPath = join(host.cwd, "shared.jsonl");
			const { sessionId } = await openFauxSession(first, host.cwd, { sessionPath });
			expect(dataOf(await second.request({ type: "open_session", cwd: host.cwd, sessionPath }))).toMatchObject({
				sessionId,
				attached: true,
			});

			const before = first.records.length;
			first.send({ type: "prompt", sessionId, message: "/raise-session", id: "raise" });
			const isRaise = (record: Record<string, unknown>) =>
				record.sessionId === sessionId &&
				record.type === "extension_ui_request" &&
				record.method === "select" &&
				record.title === "session-raise";
			const onFirst = await first.wait(isRaise);
			const onSecond = await second.wait(isRaise);
			expect(onSecond.id).toBe(onFirst.id);

			second.send({ type: "extension_ui_response", sessionId, id: onSecond.id, value: "B", answerId: "second" });
			expect(await notifiedAfter(first, sessionId, "raised:", before)).toBe("B");

			const late = first.wait(
				(record) =>
					record.type === "response" && record.command === "extension_ui_response" && record.id === onFirst.id,
			);
			first.send({ type: "extension_ui_response", sessionId, id: onFirst.id, value: "A", answerId: "first" });
			const refused = replyOf(await late);
			expect(refused.success).toBe(false);
			expect(refused.error).toBe("already_answered");
			first.close();
			second.close();
		} finally {
			await host.dispose();
		}
	}, 600_000);
});
