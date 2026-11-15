// senpi#5924 review M1: two daemons share one agent dir (two endpoints, or a predecessor and its successor during a
// handover), so they share the hand_link state. Once a successor has claimed it and advanced a session's generation,
// the predecessor refuses every batch `hand_link_host_superseded`: it never admits a generation the state on disk has
// moved past, and never writes over its successor's state.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectAuthenticatedRpcSocket } from "../../../src/modes/rpc/rpc-auth-client.ts";
import { scratch, spawnRpc, stopChild, waitForStderr } from "../../helpers/rpc-socket-host-support.ts";
import { declare, Peer } from "../rpc-delegated-host-support.ts";
import { BRAIN_A, batch, brain, call, pump, resultText } from "../rpc-hand-link-support.ts";

const COUNT_TOOL = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
	pi.registerTool({
		name: "count",
		label: "Count",
		description: "Appends one mark to count.txt in its cwd.",
		parameters: { type: "object", properties: {} },
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			appendFileSync(join(ctx.cwd, "count.txt"), "x");
			return { content: [{ type: "text", text: "counted in " + ctx.cwd }], details: {} };
		},
	});
}
`;

it("a successor that advanced a session's generation leaves the predecessor refusing every batch", async () => {
	const qa = scratch("5924-two-daemons");
	const extension = join(qa.root, "count-tool.mjs");
	writeFileSync(extension, COUNT_TOOL);
	const daemon = async (socketPath: string) => {
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${socketPath}`, "--no-skills", "--no-context-files", "-e", extension],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${socketPath}`);
		const { socket } = await connectAuthenticatedRpcSocket(socketPath, undefined, { keyRoot: qa.agentDir });
		const peer = new Peer(socket, `brain-${child.pid}`);
		expect(await declare(peer, ["hand_link"], BRAIN_A)).toMatchObject({ success: true });
		return { child, peer };
	};
	const predecessor = await daemon(qa.socketPath);
	const successor = await daemon(join(qa.root, "s2.sock"));
	try {
		const first = brain("hosted-1", 1);
		expect(resultText(await pump(predecessor.peer, first, call(first, qa.cwd, "count", {})))).toBe(
			`counted in ${qa.cwd}`,
		);
		const moved = brain("hosted-1", 2);
		expect(resultText(await pump(successor.peer, moved, call(moved, qa.cwd, "count", {})))).toBe(
			`counted in ${qa.cwd}`,
		);

		expect(await batch(predecessor.peer, first)).toMatchObject({ error: "hand_link_host_superseded" });
		expect(await batch(predecessor.peer, brain("hosted-1", 3))).toMatchObject({
			error: "hand_link_host_superseded",
		});
		expect(await batch(successor.peer, moved)).toMatchObject({ success: true });
	} finally {
		for (const { child, peer } of [predecessor, successor]) {
			peer.socket.destroy();
			await stopChild(child);
		}
	}
}, 180_000);
