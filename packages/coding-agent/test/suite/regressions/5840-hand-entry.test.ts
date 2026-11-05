// senpi#5840: `--hand` starts the engine as a hand on `<agentDir>/rpc/hand.sock`. A local carrier attaches over the
// socket with the reference transport, runs a model-issued tool call end to end on the hand's loopless runtime, and
// after its connection drops mid-call and re-attaches, every frame still arrives once: the hand runs the call once and
// the session sees one result.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createReliableTransport, HAND_CONTROL_LANE, type TransportSide } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { handSocketPath } from "../../../src/modes/hand/hand-entry.ts";
import { attachSocketCarrier, type CarrierSide } from "../../../src/modes/hand/socket-carrier.ts";
import { remoteHost, runTurn, toolCall, toolResultTexts } from "../../hand/remote-hand-fixture.ts";
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
			return { content: [{ type: "text", text: "counted in " + ctx.cwd }], details: {} };
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

async function dial(path: string): Promise<Socket> {
	const socket = createConnection(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return socket;
}

/**
 * The first connection swallows every ACK and the first scope frame the hand sends, then drops: the brain must resend
 * its invoke on the next connection (the hand sees it twice on the wire) and the hand must resend its reply.
 */
function lossyFirstConnection(brain: TransportSide, onDrop: () => void): CarrierSide {
	let dropped = false;
	return {
		attached: (connection) => brain.attached(connection),
		writable: () => brain.writable(),
		detached: () => brain.detached(),
		message: (message) => {
			if (dropped) return;
			const kind: unknown = Reflect.get(Object(message), "kind");
			if (kind === "ack") return;
			if (kind === "data" && Reflect.get(Object(message), "lane") !== HAND_CONTROL_LANE) {
				dropped = true;
				onDrop();
				return;
			}
			brain.message(message);
		},
	};
}

it("--hand runs a tool call end to end over its socket and survives a re-attach with each frame once", async () => {
	const qa = scratch("5840-hand");
	const extension = join(qa.root, "count-tool.mjs");
	writeFileSync(extension, PROBE_EXTENSION);
	// The hand endpoint lives under the agent dir; a short root keeps it inside the 103-byte socket path limit.
	const agentDir = mkdtempSync(join("/tmp", "s5840a-"));
	const endpoint = handSocketPath(agentDir);
	const child = spawnRpc(["--hand", "--no-skills", "--no-context-files", "-e", extension], qa, undefined, {
		SENPI_CODING_AGENT_DIR: agentDir,
	});
	const sockets: Socket[] = [];
	try {
		await waitForStderr(child, `senpi hand: listening on ${endpoint}`, 60_000);
		const brain = brainSide();
		const reattached = Promise.withResolvers<void>();
		const first = await dial(endpoint);
		sockets.push(first);
		let detachFirst = (): void => {};
		detachFirst = attachSocketCarrier(
			first,
			lossyFirstConnection(brain, () => {
				detachFirst();
				first.destroy();
				void dial(endpoint).then((second) => {
					sockets.push(second);
					attachSocketCarrier(second, brain);
					reattached.resolve();
				}, reattached.reject);
			}),
		);

		const { agent, events } = await runTurn({
			calls: [toolCall("call-1", "count", {})],
			toolHost: remoteHost({ brain }),
			root: qa.cwd,
		});
		await reattached.promise;

		expect(toolResultTexts(agent)).toEqual([`counted in ${qa.cwd}`]);
		expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
		expect(readFileSync(join(qa.cwd, "count.txt"), "utf8")).toBe("x");
		expect(child.exitCode).toBeNull();
		brain.close();
	} finally {
		for (const socket of sockets) socket.destroy();
		await stopChild(child);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 90_000);

it("a second --hand on the same agent dir refuses the live endpoint, and a stopped hand removes only its own entry", async () => {
	const qa = scratch("5840-hand-owner");
	const agentDir = mkdtempSync(join("/tmp", "s5840o-"));
	const endpoint = handSocketPath(agentDir);
	const env = { SENPI_CODING_AGENT_DIR: agentDir };
	const first = spawnRpc(["--hand", "--no-skills", "--no-context-files"], qa, undefined, env);
	try {
		await waitForStderr(first, `senpi hand: listening on ${endpoint}`, 60_000);
		const second = spawnRpc(["--hand", "--no-skills", "--no-context-files"], qa, undefined, env);
		let secondErr = "";
		second.stderr.on("data", (chunk: Buffer) => {
			secondErr += chunk.toString("utf8");
		});
		const exitCode = await new Promise<number | null>((resolve) => second.once("exit", resolve));
		expect(exitCode).not.toBe(0);
		expect(secondErr).toContain("address already in use by a live server");

		const stillServed = await dial(endpoint);
		stillServed.destroy();
		expect(first.exitCode).toBeNull();

		await stopChild(first);
		expect(existsSync(endpoint)).toBe(false);
	} finally {
		await stopChild(first);
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 120_000);
