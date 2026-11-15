// senpi#5924: the daemon's hand epoch fence is durable. A session advanced to generation 3 keeps running after the
// daemon restarts: its next batch at generation 3 is admitted and its floor raise is acked (a fresh floor would refuse
// generation 3 as `epoch_step_exceeded`), while a batch at generation 2 is still refused. Every answer names the link's
// `instance`: the same on every answer within one daemon process and new after the restart, so the brain knows to reset
// its hand transport.
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

it("a session at generation 3 keeps running across a daemon restart; generation 2 stays refused", async () => {
	const qa = scratch("5924-restart");
	const extension = join(qa.root, "count-tool.mjs");
	writeFileSync(extension, COUNT_TOOL);
	const daemon = async () => {
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--no-skills", "--no-context-files", "-e", extension],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const { socket } = await connectAuthenticatedRpcSocket(qa.socketPath, undefined, { keyRoot: qa.agentDir });
		const peer = new Peer(socket, `brain-${child.pid}`);
		expect(await declare(peer, ["hand_link"], BRAIN_A)).toMatchObject({ success: true });
		return { child, peer };
	};

	const instanceOf = (answer: Record<string, unknown>): unknown => (answer.data as { instance?: unknown }).instance;
	const first = await daemon();
	let hosted = brain("hosted-1", 1);
	for (const generation of [1, 2, 3]) {
		hosted = brain("hosted-1", generation);
		expect(resultText(await pump(first.peer, hosted, call(hosted, qa.cwd, "count", {})))).toBe(
			`counted in ${qa.cwd}`,
		);
	}
	const before = instanceOf(await batch(first.peer, hosted));
	expect(before).toEqual(expect.any(String));
	expect(instanceOf(await batch(first.peer, hosted))).toBe(before);
	first.peer.socket.destroy();
	await stopChild(first.child);

	const second = await daemon();
	try {
		const resumed = brain("hosted-1", 3);
		const after = instanceOf(await batch(second.peer, resumed));
		expect(after).toEqual(expect.any(String));
		expect(after).not.toBe(before);
		expect(resultText(await pump(second.peer, resumed, call(resumed, qa.cwd, "count", {})))).toBe(
			`counted in ${qa.cwd}`,
		);
		expect(instanceOf(await batch(second.peer, resumed))).toBe(after);
		expect(await batch(second.peer, brain("hosted-1", 2))).toMatchObject({ error: "hand_link_superseded" });
	} finally {
		second.peer.socket.destroy();
		await stopChild(second.child);
	}
}, 180_000);
