// senpi#5924: the production `--hand` enforces S35's epoch floor. The session runs a call at epoch 1, moves and runs
// one at epoch 2; a late call that still carries epoch 1 (the owner before the move) is refused on the spawned hand and
// the tool does not run a third time.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createReliableTransport, createRemoteToolHost, type TransportSide } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { handSocketPath } from "../../../src/modes/hand/hand-entry.ts";
import { attachSocketCarrier } from "../../../src/modes/hand/socket-carrier.ts";
import { runTurn, toolCall, toolResultTexts } from "../../hand/remote-hand-fixture.ts";
import { scratch, spawnRpc, stopChild, waitForStderr } from "../../helpers/rpc-socket-host-support.ts";

const PROBE_EXTENSION = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
	pi.registerTool({
		name: "count",
		label: "Count",
		description: "Appends one mark to count.txt in its cwd.",
		parameters: { type: "object", properties: {} },
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			appendFileSync(join(ctx.cwd, "count.txt"), "x");
			return { content: [{ type: "text", text: "counted" }], details: {} };
		},
	});
}
`;

function brainSide(): TransportSide {
	return createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
}

async function attach(path: string, sockets: Socket[]): Promise<TransportSide> {
	const socket = createConnection(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	sockets.push(socket);
	const brain = brainSide();
	attachSocketCarrier(socket, brain);
	return brain;
}

it("--hand refuses a call below the scope's epoch floor; the tool does not run", async () => {
	const qa = scratch("5924-hand-fence");
	const extension = join(qa.root, "count-tool.mjs");
	writeFileSync(extension, PROBE_EXTENSION);
	const agentDir = mkdtempSync(join("/tmp", "s5924a-"));
	const endpoint = handSocketPath(agentDir);
	const child = spawnRpc(["--hand", "--no-skills", "--no-context-files", "-e", extension], qa, undefined, {
		SENPI_CODING_AGENT_DIR: agentDir,
	});
	const sockets: Socket[] = [];
	try {
		await waitForStderr(child, `senpi hand: listening on ${endpoint}`, 60_000);
		// One carrier link per hand: each brain process in turn takes over the session's end of it (S05).
		const link = await attach(endpoint, sockets);
		const before = await runTurn({
			calls: [toolCall("call-0", "count", {})],
			toolHost: createRemoteToolHost({ transport: link, placement: "split-local", epoch: 1 }),
			root: qa.cwd,
			scopeId: "scope-5924",
		});
		expect(toolResultTexts(before.agent)).toEqual(["counted"]);

		const current = await runTurn({
			calls: [toolCall("call-1", "count", {})],
			toolHost: createRemoteToolHost({ transport: link, placement: "split-local", epoch: 2 }),
			root: qa.cwd,
			scopeId: "scope-5924",
		});
		expect(toolResultTexts(current.agent)).toEqual(["counted"]);

		const late = await runTurn({
			calls: [toolCall("call-2", "count", {})],
			toolHost: createRemoteToolHost({ transport: link, placement: "split-local", epoch: 1 }),
			root: qa.cwd,
			scopeId: "scope-5924",
		});

		expect(toolResultTexts(late.agent).join("\n")).toContain("refused");
		expect(readFileSync(join(qa.cwd, "count.txt"), "utf8")).toBe("xx");
		expect(child.exitCode).toBeNull();
		link.close();
	} finally {
		for (const socket of sockets) socket.destroy();
		await stopChild(child);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 90_000);
