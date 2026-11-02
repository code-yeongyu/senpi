/**
 * oh-my-openagent#11419 / senpi#4420 review: host idle exit waits for agent_idle so it never cuts off a settle-time
 * extension handler, but one agent_settled handler that never resolves must not keep the host alive forever. Once
 * every client left, the host exits after its idle window even while such a handler is still pending.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeldAnthropicModel, JsonlPeer, openedSessionId } from "./helpers/rpc-generation-support.ts";
import { endpointScratch, realHost, sweepEndpointScratches, tracked } from "./helpers/rpc-host-endpoint-scratch.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

const IDLE_EXIT_MS = 1_000;
/** Far below "never" and far above the idle window plus a loaded machine's slack: what this proves is a bound. */
const EXIT_BOUND_MS = 30_000;

afterEach(sweepEndpointScratches, 180_000);

describe.skipIf(process.platform === "win32")("idle exit with an agent_settled handler that never resolves", () => {
	for (const kind of ["worker", "interactive"] as const) {
		it(`exits once every client left, though a ${kind} session's settled handler is still pending`, async () => {
			// given a host whose extension's agent_settled handler never resolves, and a retained session that settled
			const held = await HeldAnthropicModel.start();
			tracked.models.push(held);
			held.release();
			const qa = endpointScratch(`hs${kind.slice(0, 1)}`, held.origin);
			const extension = join(qa.cwd, "hang-settled.ts");
			writeFileSync(
				extension,
				'export default function (pi) { pi.on("agent_settled", () => new Promise(() => {})); }\n',
			);
			const supervisor = await realHost(qa, qa.legacy, { idleExitMs: IDLE_EXIT_MS, extension });
			const client = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(client);
			const sessionId = openedSessionId(
				await client.request({ id: "open", type: "open_session", cwd: qa.cwd, kind, retain_on_disconnect: true }),
			);
			const settled = client.waitFor((record) => record.type === "agent_settled" && record.sessionId === sessionId);
			await client.request({ id: "prompt", type: "prompt", sessionId, message: "hello" });
			await settled;

			// when every client leaves
			client.destroy();

			// then the supervisor still exits, bounded by its idle window rather than by the hung handler
			expect(await waitForPidGone(supervisor, EXIT_BOUND_MS)).toBe(true);
		}, 120_000);
	}
});
