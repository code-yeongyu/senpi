// senpi#7098 follow-up (review of #7105, MEDIUM-4). The rows a predecessor lists were cast, not parsed: a malformed
// row from a version-skewed generation crashed the successor's own `list_sessions`, or was relayed as a routed row.
// A row that does not have the shape the successor reads is now skipped, and a well-formed one still routes.
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	answer,
	type Cleanups,
	fakePredecessor,
	successorWithPredecessorClaim,
} from "../rpc-predecessor-route-support.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.skipIf(process.platform === "win32")(
	"malformed predecessor rows are skipped while a well-formed one is listed through its route",
	async () => {
		const host = await successorWithPredecessorClaim(cleanups);
		const ownPath = join(host.root, "own.jsonl");
		expect(
			await host.send({
				type: "open_session",
				id: "own",
				cwd: host.root,
				sessionPath: ownPath,
				retain_on_disconnect: true,
			}),
		).toMatchObject({ success: true });
		await host.predecessorHolds();
		const wellFormed = {
			sessionId: "upstream-1",
			sessionPath: host.heldPath,
			cwd: host.root,
			status: "open",
			attachments: 0,
			retain_on_disconnect: true,
			kind: "interactive",
			context: {},
		};
		await fakePredecessor(cleanups, host, {
			list_sessions: (stream, request) =>
				answer(stream, request, {
					sessions: [null, { sessionId: 42, sessionPath: host.heldPath, status: "open" }, wellFormed],
				}),
		});

		const listed = await host.list();

		expect(listed, JSON.stringify(listed)).toMatchObject({ success: true });
		const rows = (listed as { data: { sessions: Array<Record<string, unknown>> } }).data.sessions;
		expect(rows.map((row) => [row.sessionPath, row.hostInstanceId])).toEqual([
			[ownPath, "succ"],
			[host.heldPath, "pred"],
		]);
	},
);
