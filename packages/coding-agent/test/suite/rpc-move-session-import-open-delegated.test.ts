/**
 * senpi#6267 with senpi#5808: the open an `import` asks for with `open` is an open on the importing connection, so on a
 * delegated connection it is retained whatever it asks, as an `open_session` there is. Runs on the bare host's
 * per-connection dispatch over a real socket (`rpc-delegated-host-support.ts`), where that rule is applied at line
 * receipt; the exporting device is an in-process host.
 */
import { describe, expect, it } from "vitest";
import { declare, startHost } from "./rpc-delegated-host-support.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const GRANTED = ["observe", "drive", "answer", "thread", "device_admin"];

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
				const importer = await host.proven();
				expect(await declare(importer, GRANTED)).toMatchObject({ success: true });
				expect(await importer.send({ type: "move_session", op: "prepare", moveId: "move-g1" })).toMatchObject({
					success: true,
				});
				await hostAndRelease(a, fixture.repoA, fixture.sessionPath, "move-g1");
				const exported = await move(a, {
					op: "export",
					sessionPath: fixture.sessionPath,
					moveId: "move-g1",
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
				expect(imported).toMatchObject({
					success: true,
					data: { session_id: SESSION_ID, sessionId: expect.any(String) },
				});
				const { sessionId } = imported.data as { sessionId: string };
				await host.drop(importer);

				const lister = await host.proven();
				const { sessions } = (await lister.send({ type: "list_sessions" })).data as {
					sessions: Array<{ sessionId: string }>;
				};
				expect(sessions.find((row) => row.sessionId === sessionId)).toMatchObject({
					attachments: 0,
					retain_on_disconnect: true,
				});
			} finally {
				await host.dispose();
			}
		},
	);
});
