// senpi#5675 (S14, R17.b): a background bash on the hand wakes the brain through the durable outbox, inbox and ack.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { createWakeInbox } from "../../../agent/src/execution/wake-inbox.ts";
import { createWakeOutbox } from "../../../agent/src/execution/wake-outbox.ts";
import type { WakeEvent } from "../../../agent/src/execution/wake-types.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { deliverTerminalWake, terminalWakeSender } from "../../src/core/execution/wake-delivery.ts";
import { createTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { TERMINAL_NOTIFICATION_CUSTOM_TYPE } from "../../src/core/extensions/builtin/terminal/notify.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const WAIT_MS = 15_000;

const WAITER_SOURCE = `const net = require("node:net");
const socket = net.connect(Number(process.argv[2]), "127.0.0.1");
socket.once("data", (data) => {
	process.stdout.write("R17_WAKE_TAIL:" + data.toString() + "\\n");
	socket.destroy();
});
`;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${WAIT_MS}ms`)), WAIT_MS);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nextEvent(harness: Harness, type: AgentSessionEvent["type"]): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

const notices = (harness: Harness): CustomMessage[] =>
	harness.session.messages.filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === TERMINAL_NOTIFICATION_CUSTOM_TYPE,
	);

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(): Promise<{ port: number; connected: Promise<Socket> }> {
	const server = createServer();
	const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback server has no port");
	return { port: address.port, connected };
}

async function claimedStore() {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	return openMemoryStore(medium);
}

describe.skipIf(process.platform === "win32")("R17.b: a hand's background bash wakes the brain durably", () => {
	it("commits the wake on the hand, keeps it while the brain is unreachable, and wakes the brain once", async () => {
		const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		cleanups.push(() => {
			if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
			else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		});
		const dir = mkdtempSync(join(tmpdir(), "senpi-r17-wake-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const waiter = join(dir, "waiter.cjs");
		writeFileSync(waiter, WAITER_SOURCE);
		const { port, connected } = await listen();

		// The hand's outbox and the brain's inbox, each on its own durable store; scope "s" is bound to hand "h1".
		const outbox = createWakeOutbox({
			hand: "h1",
			store: await claimedStore(),
			epoch: 1,
			admission: createAdmissionLine(),
			clock: () => Date.now(),
		});
		const inbox = createWakeInbox({
			issuer: "brain",
			store: await claimedStore(),
			epoch: 1,
			admission: createAdmissionLine(),
			clock: () => Date.now(),
			owner: (scope) => (scope === "s" ? "h1" : undefined),
		});
		let linkUp = false;
		const send = async (wake: WakeEvent) => {
			if (!linkUp) throw new Error("the brain is unreachable");
			return inbox.receive("h1", wake);
		};
		const failed = Promise.withResolvers<unknown>();

		const hand = await createHarness({
			cwd: dir,
			extensionFactories: [
				createTerminalExtension({
					sendMessage: terminalWakeSender({ outbox, scope: "s", send, onError: failed.resolve }),
				}),
			],
		});
		let brainPi: ExtensionAPI | undefined;
		const brain = await createHarness({
			cwd: dir,
			extensionFactories: [
				(pi) => {
					brainPi = pi;
				},
			],
		});
		cleanups.push(async () => {
			await hand.session.executeTool("kill_bash", { all: true });
			hand.cleanup();
			brain.cleanup();
		});
		await hand.session.bindExtensions({ mode: "tui" });
		await brain.session.bindExtensions({ mode: "tui" });
		hand.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: `"${process.execPath}" "${waiter}" ${port}`,
						description: "r17 waiter",
						run_in_background: true,
					},
					{ id: "r17-start" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started"),
		]);
		await hand.session.prompt("start the waiter");
		const socket = await withTimeout(connected, "the background waiter connecting");

		// The background bash finishes while the brain is unreachable: the wake is durable on the hand, nowhere else.
		socket.write("PING");
		expect(String(await withTimeout(failed.promise, "the failed send"))).toContain("the brain is unreachable");
		const [pending] = await outbox.pending();
		expect(pending).toMatchObject({ scope: "s", source: "terminal" });
		expect(notices(hand)).toEqual([]);
		expect((await inbox.read()).pending).toEqual([]);

		// The link comes back: the re-offer commits it on the brain, its ack removes it from the hand.
		linkUp = true;
		expect(await outbox.reoffer(send)).toBe(1);
		expect(await outbox.pending()).toEqual([]);

		// The brain's loop takes it once and delivers the very notice a fused session would have made.
		brain.setResponses([fauxAssistantMessage("woke")]);
		const wakeTurnEnded = nextEvent(brain, "agent_end");
		const sendMessage = brainPi?.sendMessage;
		if (sendMessage === undefined) throw new Error("the brain's extension did not load");
		expect(await inbox.drain(async (wake) => deliverTerminalWake(wake, sendMessage))).toBe(1);
		await withTimeout(wakeTurnEnded, "the brain's wake turn ending");
		await withTimeout(brain.session.waitForSettledSessionWork(), "the brain settling");
		expect(notices(brain)).toHaveLength(1);
		expect(notices(brain)[0]).toMatchObject({ display: false });
		expect(notices(brain)[0]?.content).toBe(
			"<system-reminder>Background terminal session bash_1 finished: completed (exit code 0).\n" +
				"Final output:\nR17_WAKE_TAIL:PING</system-reminder>",
		);

		// A late duplicate (its ack lost) is deduplicated: the brain is never woken twice.
		expect(await inbox.receive("h1", pending as WakeEvent)).toMatchObject({ kind: "ack", duplicate: true });
		expect(await inbox.drain(async () => {})).toBe(0);
		expect(notices(hand)).toEqual([]);
	});
});
