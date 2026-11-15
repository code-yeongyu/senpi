// senpi#5778 (H3): a spawned `--hand` sends what a call's work produces after the call ended over the wake lane of its
// socket transport. A background command's exit notice reaches the brain's inbox; when the receipt is lost and the hand
// restarts, the new process re-offers it from `<agentDir>/rpc/hand-wakes.json`, and the brain takes it exactly once.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
	createAdmissionLine,
	createMemoryStoreMedium,
	createReliableTransport,
	createWakeInbox,
	type FrameHandler,
	HAND_WAKE_LANE,
	openMemoryStore,
	serveHandWakes,
	type Transport,
	type TransportSide,
	type WakeEvent,
} from "@earendil-works/pi-agent-core";
import { decodeReferencePacket } from "@earendil-works/pi-agent-core/conformance";
import { expect, it } from "vitest";
import { parseHandWake } from "../../../src/core/execution/wake-delivery.ts";
import { TERMINAL_NOTIFICATION_CUSTOM_TYPE } from "../../../src/core/extensions/builtin/terminal/notify.ts";
import { handSocketPath, handWakeStorePath } from "../../../src/modes/hand/hand-entry.ts";
import { openHandWakeOutbox } from "../../../src/modes/hand/hand-wakes.ts";
import { attachSocketCarrier } from "../../../src/modes/hand/socket-carrier.ts";
import { arrivals, within } from "../../hand/hand-wake-fixture.ts";
import { remoteHost, runTurn, toolCall } from "../../hand/remote-hand-fixture.ts";
import { scratch, spawnRpc, stopChild, waitForStderr } from "../../helpers/rpc-socket-host-support.ts";

const WAITER = `const socket = require("node:net").connect(Number(process.argv[2]), "127.0.0.1");
socket.once("data", (data) => { process.stdout.write("H3_TAIL:" + data.toString() + "\\n"); socket.destroy(); });`;

const HAND = "spawned-hand";

/** The brain's end of one hand connection: the wake lane to the brain's inbox, every other lane to `rest`. */
async function brainLink(endpoint: string, wakes: (wake: Transport) => void) {
	const brain: TransportSide = createReliableTransport({
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
	const handlers = new Map<string, FrameHandler>();
	brain.onFrame((frame) => handlers.get(frame.lane === HAND_WAKE_LANE ? HAND_WAKE_LANE : "")?.(frame));
	const view = (key: string): Transport => ({ ...brain, onFrame: (handler) => void handlers.set(key, handler) });
	wakes(view(HAND_WAKE_LANE));
	const socket: Socket = createConnection(endpoint);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const acks = arrivals<void>();
	attachSocketCarrier(
		socket,
		{
			...brain,
			message: (message) => {
				brain.message(message);
				const packet = decodeReferencePacket(message);
				if (packet.kind === "ack" && packet.lane === HAND_WAKE_LANE && brain.inFlight(HAND_WAKE_LANE) === 0)
					acks.push();
			},
		},
		() => {},
	);
	return { brain, rest: view(""), acks, close: () => (socket.destroy(), brain.close()) };
}

it("--hand delivers a background exit notice on its wake lane and re-offers it from disk after a restart", async () => {
	const qa = scratch("5778-hand-wakes");
	const waiter = join(qa.root, "waiter.cjs");
	writeFileSync(waiter, WAITER);
	const agentDir = mkdtempSync(join("/tmp", "s5778a-"));
	const endpoint = handSocketPath(agentDir);
	const env = { SENPI_CODING_AGENT_DIR: agentDir, SENPI_PTY_FORCE_PIPE: "1" };
	const server = createServer();
	const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback server has no port");
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const inbox = createWakeInbox({
		issuer: "brain",
		store: openMemoryStore(medium),
		epoch: 1,
		admission: createAdmissionLine(),
		clock: () => Date.now(),
		owner: () => HAND,
	});
	const committed = arrivals<WakeEvent>();
	const serve = (transport: Transport, loseReceipts: boolean) =>
		serveHandWakes({
			transport: loseReceipts ? { ...transport, send: () => Promise.resolve() } : transport,
			inbox,
			hand: HAND,
			onCommitted: committed.push,
			onDropped: () => {},
			onFault: (error) => {
				throw error;
			},
		});
	const children: ReturnType<typeof spawnRpc>[] = [];
	const links: Array<{ close: () => void }> = [];
	try {
		const first = spawnRpc(["--hand", "--no-skills", "--no-context-files"], qa, undefined, env);
		children.push(first);
		await waitForStderr(first, `senpi hand: listening on ${endpoint}`);
		const lossy = await brainLink(endpoint, (wakes) => void serve(wakes, true));
		links.push(lossy);
		await runTurn({
			calls: [
				toolCall("bg-1", "bash", {
					command: `"${process.execPath}" "${waiter}" ${address.port}`,
					description: "h3 waiter",
					run_in_background: true,
				}),
			],
			toolHost: remoteHost({ brain: { ...lossy.brain, onFrame: lossy.rest.onFrame } }),
			root: qa.cwd,
		});
		(await within(connected, "the background waiter connecting")).write("PING");
		const wake = await committed.next("the exit notice's wake");
		const delivery = parseHandWake(wake);
		expect(delivery).toMatchObject({ kind: "message", message: { customType: TERMINAL_NOTIFICATION_CUSTOM_TYPE } });
		expect(delivery.kind === "message" ? delivery.message.content : "").toContain("H3_TAIL:PING");
		lossy.close();
		await stopChild(first);

		const second = spawnRpc(["--hand", "--no-skills", "--no-context-files"], qa, undefined, env);
		children.push(second);
		await waitForStderr(second, `senpi hand: listening on ${endpoint}`);
		const link = await brainLink(endpoint, (wakes) => void serve(wakes, false));
		links.push(link);
		await link.acks.next("the restarted hand applying the brain's receipt");
		link.close();
		await stopChild(second);

		expect(committed.all.map((entry) => entry.eventId)).toEqual([wake.eventId]);
		expect(await inbox.drain(async () => {})).toBe(1);
		expect(await (await openHandWakeOutbox(handWakeStorePath(agentDir))).pending()).toEqual([]);
	} finally {
		for (const link of links) link.close();
		for (const child of children) await stopChild(child);
		server.close();
		rmSync(agentDir, { recursive: true, force: true });
	}
}, 120_000);
