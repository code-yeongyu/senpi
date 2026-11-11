/**
 * senpi#6267 on the route a forwarder uses: a delegated connection to a host that was started outside the folder the
 * session moves into. The open an `import` asks for with `open` is an open on the importing connection, so it is
 * retained whatever it asks, as an `open_session` there is (senpi#5808), and the opened session works in the folder
 * the import named, not in the host's own (senpi#6427). Runs on the bare host's per-connection dispatch over a real
 * socket with a real runtime (`rpc-delegated-host-support.ts`); the exporting device is an in-process host.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DelegatedHost, declare, type Peer, startHost } from "./rpc-delegated-host-support.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move, type Rig } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const GRANTED = ["observe", "drive", "answer", "thread", "device_admin"];
const MOVE_ID = "move-g1";

type Devices = Awaited<ReturnType<typeof devices>>;

interface Opened {
	readonly sessionId: string;
	readonly session_path: string;
	readonly state: { readonly cwd: string };
}

/** A delegated connection readies the move, the other device exports it, and the connection imports it with `open`. */
async function importedWithOpen(
	host: DelegatedHost,
	exporter: Rig,
	fixture: Devices,
	open: true | Record<string, unknown>,
): Promise<{ readonly importer: Peer; readonly opened: Opened }> {
	const importer = await host.proven();
	expect(await declare(importer, GRANTED)).toMatchObject({ success: true });
	expect(await importer.send({ type: "move_session", op: "prepare", moveId: MOVE_ID })).toMatchObject({
		success: true,
	});
	await hostAndRelease(exporter, fixture.repoA, fixture.sessionPath, MOVE_ID);
	const exported = await move(exporter, {
		op: "export",
		sessionPath: fixture.sessionPath,
		moveId: MOVE_ID,
		target: "device-b",
	});
	const { bundle_dir: bundleDir } = exported.data as { bundle_dir: string };
	const imported = await importer.send({
		type: "move_session",
		op: "import",
		bundleDir,
		cwd: fixture.repoB,
		from: "device-a",
		open,
	});
	expect(imported).toMatchObject({ success: true, data: { session_id: SESSION_ID, sessionId: expect.any(String) } });
	return { importer, opened: imported.data as Opened };
}

describe("move_session import with open on a delegated connection (senpi#6267)", () => {
	it.each<[string, true | Record<string, unknown>]>([
		["a plain open", true],
		["an open that asks to close on disconnect", { retain_on_disconnect: false }],
	])(
		"#given %s #when the delegated importing connection ends #then the opened session stays loaded",
		async (_case, open) => {
			const fixture = await devices();
			const host = await startHost();
			await using a = createInProcessRig(fixture.agentA);
			try {
				const { importer, opened } = await importedWithOpen(host, a, fixture, open);
				await host.drop(importer);

				const lister = await host.proven();
				const { sessions } = (await lister.send({ type: "list_sessions" })).data as {
					sessions: Array<{ sessionId: string }>;
				};
				expect(sessions.find((row) => row.sessionId === opened.sessionId)).toMatchObject({
					attachments: 0,
					retain_on_disconnect: true,
				});
			} finally {
				await host.dispose();
			}
		},
	);

	it("#given a host started outside the folder the import names #when the import opens the landed session #then the session works in the import's folder and its file records no other", async () => {
		const fixture = await devices();
		const host = await startHost();
		await using a = createInProcessRig(fixture.agentA);
		try {
			const { importer, opened } = await importedWithOpen(host, a, fixture, true);
			const state = (await importer.send({ type: "get_state", sessionId: opened.sessionId })).data as {
				cwd: string;
			};
			const { sessions } = (await importer.send({ type: "list_sessions" })).data as {
				sessions: Array<{ sessionId: string; cwd: string }>;
			};

			expect(host.cwd).not.toBe(fixture.repoB);
			expect({
				answered: opened.state.cwd,
				state: state.cwd,
				listed: sessions.find((row) => row.sessionId === opened.sessionId)?.cwd,
				recordsHostFolder: readFileSync(opened.session_path, "utf8").includes(host.cwd),
			}).toEqual({
				answered: fixture.repoB,
				state: fixture.repoB,
				listed: fixture.repoB,
				recordsHostFolder: false,
			});
		} finally {
			await host.dispose();
		}
	});
});
