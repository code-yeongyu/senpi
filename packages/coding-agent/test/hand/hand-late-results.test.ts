// H3 (brain/hand split, senpi#5778): what a hand's work produces for the loop after the call that started it ended
// reaches the brain once, as a local session would see it, or the brain is told it was dropped.
import { writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
	createAdmissionLine,
	createMemoryStoreMedium,
	createWakeOutbox,
	openMemoryStore,
	WAKE_RETENTION_MS,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { deliverHandWake, parseHandWake } from "../../src/core/execution/wake-delivery.ts";
import { TERMINAL_NOTIFICATION_CUSTOM_TYPE } from "../../src/core/extensions/builtin/terminal/notify.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import { createHarness } from "../suite/harness.ts";
import { openHandWakeOutbox } from "../../src/modes/hand/hand-wakes.ts";
import { createLooplessHand, type HandWakes } from "../../src/modes/rpc/remote-executor-scope.ts";
import { brainInbox, connect, observed, within } from "./hand-wake-fixture.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await cleanupHands();
});

const noPlanes = () => Promise.reject(new Error("this loop serves no planes"));
const callOf = (name: string, args: unknown, toolCallId = `${name}-1`) => ({
	name,
	toolCallId,
	arguments: args,
	signal: new AbortController().signal,
	nested: noPlanes,
});

/** A user extension whose tool returns at once and sends a message later, when the test fires `h3Fire`. */
const LATE_TOOL_EXTENSION = `import { Type } from "typebox";
export default (pi) => pi.registerTool({
	name: "late_work",
	label: "late work",
	description: "starts work that reports after the call",
	parameters: Type.Object({}),
	async execute() {
		const gate = Promise.withResolvers();
		globalThis.h3Fire = gate.resolve;
		void gate.promise.then((text) => pi.sendMessage({ customType: "late-work", content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" }));
		return { content: [{ type: "text", text: "started" }], details: {} };
	},
});`;

async function lateToolHand(prefix: string, wakes: HandWakes) {
	const dirs = await handDirs(prefix);
	const extension = join(dirs.scratch, "late-tool.ts");
	writeFileSync(extension, LATE_TOOL_EXTENSION);
	const machine = createLooplessHand(handConfiguration(dirs, ["-e", extension]), { wakes });
	cleanups.push(() => machine.close());
	const scope = await machine.openScope({ id: "s", root: dirs.cwd });
	expect((await scope.run(callOf("late_work", {}))).content).toEqual([{ type: "text", text: "started" }]);
	const fire = (globalThis as { h3Fire?: (text: string) => void }).h3Fire;
	if (fire === undefined) throw new Error("the late tool did not start its work");
	return { dirs, scope, fire };
}

const WAITER_SOURCE = `const socket = require("node:net").connect(Number(process.argv[2]), "127.0.0.1");
socket.once("data", (data) => { process.stdout.write("H3_TAIL:" + data.toString() + "\\n"); socket.destroy(); });`;

async function loopback(): Promise<{ port: number; connected: Promise<Socket> }> {
	const server = createServer();
	const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback server has no port");
	return { port: address.port, connected };
}

describe.skipIf(process.platform === "win32")("late results of a hand's work reach the brain (H3)", () => {
	it("delivers a background command's exit notice, after its call ended, as one wake the loop sends like a session", async () => {
		const forcePipe = process.env.SENPI_PTY_FORCE_PIPE;
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		cleanups.push(() => {
			if (forcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
			else process.env.SENPI_PTY_FORCE_PIPE = forcePipe;
		});
		const dirs = await handDirs("h3-bash");
		const waiter = join(dirs.scratch, "waiter.cjs");
		writeFileSync(waiter, WAITER_SOURCE);
		const { port, connected } = await loopback();
		const brain = await brainInbox();
		const link = connect(brain, await openHandWakeOutbox(join(dirs.agentDir, "hand-wakes.json")));
		cleanups.push(() => link.close());
		const machine = createLooplessHand(handConfiguration(dirs), { wakes: link.wakes });
		cleanups.push(() => machine.close());
		const scope = await machine.openScope({ id: "s", root: dirs.cwd });
		cleanups.push(() => void scope.run(callOf("kill_bash", { all: true }, "kill-all")));

		const started = await scope.run(
			callOf("bash", {
				command: `"${process.execPath}" "${waiter}" ${port}`,
				description: "h3 waiter",
				run_in_background: true,
			}),
		);
		expect(started.isError).not.toBe(true);
		(await within(connected, "the background waiter connecting")).write("PING");
		const wake = await brain.committed.next("the exit notice's wake");

		expect(wake).toMatchObject({ scope: "s", source: "message" });
		expect(parseHandWake(wake)).toMatchObject({ kind: "message", options: { triggerTurn: true } });

		// The brain's session takes the wake once and gets the very notice a local session makes for that exit.
		let brainPi: ExtensionAPI | undefined;
		const loop = await createHarness({ cwd: dirs.cwd, extensionFactories: [(pi) => void (brainPi = pi)] });
		cleanups.push(() => loop.cleanup());
		await loop.session.bindExtensions({ mode: "tui" });
		loop.setResponses([fauxAssistantMessage("woke")]);
		const turnEnded = new Promise<void>((resolve) => {
			const stop = loop.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				stop();
				resolve();
			});
		});
		const pi = brainPi;
		if (pi === undefined) throw new Error("the brain's extension did not load");
		const session = {
			sendMessage: pi.sendMessage,
			sendUserMessage: pi.sendUserMessage,
			appendEntry: pi.appendEntry,
			notify: () => {},
			context: () => ({ mode: "tui", model: loop.session.model }),
		};
		expect(await brain.inbox.drain(async (taken) => void deliverHandWake(taken, session))).toBe(1);
		await within(turnEnded, "the brain's wake turn");
		await within(loop.session.waitForSettledSessionWork(), "the brain settling");
		const notices = loop.session.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === TERMINAL_NOTIFICATION_CUSTOM_TYPE,
		);
		expect(notices.map((notice) => [notice.display, notice.content])).toEqual([
			[
				false,
				"<system-reminder>Background terminal session bash_1 finished: completed (exit code 0).\n" +
					"Final output:\nH3_TAIL:PING</system-reminder>",
			],
		]);
		expect(await brain.inbox.drain(async () => {})).toBe(0);
	});

	it("re-offers a wake whose receipt was lost, from the hand's durable store, and the loop takes it once", async () => {
		const brain = await brainInbox();
		const dirs = await handDirs("h3-store");
		const storePath = join(dirs.agentDir, "hand-wakes.json");
		const lossy = connect(brain, await openHandWakeOutbox(storePath), { loseReceipts: true });
		cleanups.push(() => lossy.close());
		const { fire } = await lateToolHand("h3-lost-receipt", lossy.wakes);

		fire("done after the call");
		const first = await brain.committed.next("the first delivery");
		lossy.close();
		const restarted = await openHandWakeOutbox(storePath);
		expect((await restarted.pending()).map((wake) => wake.eventId)).toEqual([first.eventId]);
		const acked = Promise.withResolvers<void>();
		const next = connect(brain, observed(restarted, { acked: acked.resolve }));
		cleanups.push(() => next.close());
		await within(acked.promise, "the re-offer's ack");
		expect(await restarted.pending()).toEqual([]);

		const taken: unknown[] = [];
		const session = {
			sendMessage: (...args: unknown[]) => void taken.push(args),
			sendUserMessage: () => {},
			appendEntry: () => {},
			notify: () => {},
			context: () => ({ mode: "tui", model: {} }),
		};
		expect(await brain.inbox.drain(async (wake) => void deliverHandWake(wake, session))).toBe(1);
		expect(taken).toEqual([
			[
				{ customType: "late-work", content: "done after the call", display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			],
		]);
		expect(brain.committed.all).toHaveLength(1);
	});

	it("tells the brain how many wakes of a disposed scope expired un-acked, once it owns the scope again", async () => {
		let now = 1_000;
		let owned = false;
		const medium = createMemoryStoreMedium();
		await openMemoryStore(medium).claim(0, 1);
		const outbox = createWakeOutbox({
			hand: "hand",
			store: openMemoryStore(medium),
			epoch: 1,
			admission: createAdmissionLine(),
			clock: () => now,
		});
		const recorded = Promise.withResolvers<void>();
		const brain = await brainInbox(() => owned);
		const link = connect(brain, observed(outbox, { offered: recorded.resolve }));
		cleanups.push(() => link.close());
		const { scope, fire } = await lateToolHand("h3-expired", link.wakes);
		fire("nobody owns this scope yet");
		await within(recorded.promise, "the wake being recorded");

		await scope.dispose();
		now += WAKE_RETENTION_MS + 1;
		owned = true;
		link.brain.reoffer();

		const drop = await brain.committed.next("the drop report");
		expect([drop.scope, drop.source, drop.payload]).toEqual(["s", "wake.dropped", { reason: "expired", count: 1 }]);
		expect(await outbox.pending()).toEqual([]);
		expect(brain.committed.all).toEqual([drop]);
	});
});
