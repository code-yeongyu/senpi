import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rawClient } from "../rpc-raw-socket-client.ts";
import {
	dataOf,
	type HostRuntime,
	openFauxSession,
	PROBE_TEXT,
	permissionModeHost,
	readTurn,
	replyOf,
	stateOf,
} from "../rpc-permission-mode-support.ts";

// Remote approval-mode work (tracked privately): a remote client could neither confirm which approval mode a session enforces nor move a live session to
// another one without knowing its host path, and the mode a client named was gone after a preset-less reopen.

describe("#6189 permission mode on the wire", () => {
	it("echoes the named preset, its source and its status on open_session and get_state", async () => {
		const host = await permissionModeHost();
		try {
			const client = await rawClient(host.socketPath);

			const named = await openFauxSession(client, host.cwd, { permissionPreset: "ask" });
			expect(named.data).toMatchObject({
				permissionPreset: "ask",
				permissionPresetSource: "client",
				permissionPresetStatus: "applied",
			});
			expect(await stateOf(client, named.sessionId)).toMatchObject({
				permissionPreset: "ask",
				permissionPresetSource: "client",
				permissionPresetStatus: "applied",
				effectivePermissionPreset: "ask",
			});

			const unnamed = await stateOf(client, (await openFauxSession(client, host.cwd)).sessionId);
			expect(unnamed).toMatchObject({ permissionPresetSource: "host_default", permissionPresetStatus: "applied" });
			expect(unnamed.permissionPreset).toBe(unnamed.effectivePermissionPreset);

			// An unknown preset keeps the #2617 contract (the open is accepted, every tool call refused) but never
			// counts as a mode the client set.
			const misspelled = await openFauxSession(client, host.cwd, { permissionPreset: "full-acess" });
			expect(misspelled.data).toMatchObject({
				permissionPresetSource: "host_default",
				permissionPresetStatus: "invalid",
			});
			client.close();
		} finally {
			await host.dispose();
		}
	}, 600_000);

	it.each<HostRuntime>(["in-process", "worker"])(
		"set_permission_preset moves a live %s session, echoes the mode and refuses an unknown preset",
		async (runtime) => {
			const host = await permissionModeHost(runtime);
			try {
				const client = await rawClient(host.socketPath);
				const { sessionId } = await openFauxSession(client, host.cwd, { permissionPreset: "full-access" });
				const open = await readTurn(client, sessionId);
				expect(open.asked).toEqual([]);
				expect(open.result).toContain(PROBE_TEXT);

				const set = await client.request({ type: "set_permission_preset", sessionId, permissionPreset: "ask" });
				expect(dataOf(set)).toEqual({
					permissionPreset: "ask",
					permissionPresetSource: "client",
					permissionPresetStatus: "applied",
				});
				const strict = await readTurn(client, sessionId);
				expect(strict.asked).toEqual(["Permission required: read"]);
				expect(strict.result).not.toContain(PROBE_TEXT);

				const refused = replyOf(
					await client.request({ type: "set_permission_preset", sessionId, permissionPreset: "full-acess" }),
				);
				expect(refused.success).toBe(false);
				expect(refused.error).toMatch(/^invalid_launch_profile: /);
				expect(await stateOf(client, sessionId)).toMatchObject({
					permissionPreset: "ask",
					permissionPresetSource: "client",
				});
				client.close();
			} finally {
				await host.dispose();
			}
		},
		600_000,
	);

	it("records a client-set preset in the session file, while a local preset-less reopen keeps the host default", async () => {
		const host = await permissionModeHost();
		try {
			const client = await rawClient(host.socketPath);
			const sessionPath = join(host.cwd, "kept.jsonl");
			const first = await openFauxSession(client, host.cwd, { sessionPath, permissionPreset: "full-access" });
			expect((await readTurn(client, first.sessionId)).asked).toEqual([]);
			dataOf(
				await client.request({
					type: "set_permission_preset",
					sessionId: first.sessionId,
					permissionPreset: "ask",
				}),
			);
			dataOf(await client.request({ type: "close_session", sessionId: first.sessionId }));

			const recorded = (await readFile(sessionPath, "utf8"))
				.split("\n")
				.filter((line) => line.includes('"customType":"permission_mode"'))
				.map((line) => JSON.parse(line).data);
			expect(recorded.at(-1)).toEqual({ preset: "ask", source: "client" });

			const reopened = await openFauxSession(client, host.cwd, { sessionPath });
			expect(await stateOf(client, reopened.sessionId)).toMatchObject({
				permissionPreset: "full-access",
				permissionPresetSource: "host_default",
				effectivePermissionPreset: "full-access",
			});
			const unchanged = await readTurn(client, reopened.sessionId);
			expect(unchanged.asked).toEqual([]);
			expect(unchanged.result).toContain(PROBE_TEXT);
			client.close();
		} finally {
			await host.dispose();
		}
	}, 600_000);
});
