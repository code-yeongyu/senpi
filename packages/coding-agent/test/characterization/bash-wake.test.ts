import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { TERMINAL_NOTIFICATION_CUSTOM_TYPE } from "../../src/core/extensions/builtin/terminal/notify.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../suite/harness.ts";

// X6 (plan P0-04b): today's bash wake on the default in-process tool runtime. A background
// bash session started in one turn that finishes while the interactive session is idle wakes
// the session exactly once: one hidden `senpi-terminal:notification` message carrying the exit
// status and the final output tail starts a new model turn, with no synthetic user message.

const WAIT_MS = 15_000;

// The background command blocks on a loopback socket the test owns, so the test decides
// exactly when it finishes: no sleeps, no polling.
const WAITER_SOURCE = `const net = require("node:net");
const socket = net.connect(Number(process.argv[2]), "127.0.0.1");
socket.once("data", (data) => {
	process.stdout.write("X6_WAKE_TAIL:" + data.toString() + "\\n");
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

function terminalNotices(harness: Harness): CustomMessage[] {
	return harness.session.messages.filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === TERMINAL_NOTIFICATION_CUSTOM_TYPE,
	);
}

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

describe.skipIf(process.platform === "win32")("X6: bash wake", () => {
	it("wakes an idle interactive session once with a hidden notice when a background bash finishes", async () => {
		// Given: an interactive session whose model starts a background bash that waits on the test.
		const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		cleanups.push(() => {
			if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
			else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		});
		const dir = mkdtempSync(join(tmpdir(), "senpi-x6-bash-wake-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const waiter = join(dir, "waiter.cjs");
		writeFileSync(waiter, WAITER_SOURCE);
		const { port, connected } = await listen();

		const harness = await createHarness({ cwd: dir, extensionFactories: [registerTerminalExtension] });
		cleanups.push(async () => {
			// `all` reports a count instead of an error when the waiter already exited, so a real
			// kill failure (a test that failed with the waiter still running) is not swallowed.
			await harness.session.executeTool("kill_bash", { all: true });
			harness.cleanup();
		});
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: `"${process.execPath}" "${waiter}" ${port}`,
						description: "x6 waiter",
						run_in_background: true,
					},
					{ id: "x6-start" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("start the waiter");
		const socket = await withTimeout(connected, "the background waiter connecting");
		expect(harness.session.isIdle).toBe(true);
		expect(terminalNotices(harness)).toEqual([]);

		let wakeContext: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				wakeContext = context;
				return fauxAssistantMessage("woke");
			},
		]);
		const wakeTurnStarted = nextEvent(harness, "agent_start");
		const wakeTurnEnded = nextEvent(harness, "agent_end");

		// When: the background bash finishes while the session is idle.
		socket.write("PING");
		await withTimeout(wakeTurnStarted, "the wake turn starting");
		await withTimeout(wakeTurnEnded, "the wake turn ending");
		// A second wake would start only after the first turn's agent_end, so settle before counting.
		await withTimeout(harness.session.waitForSettledSessionWork(), "the session settling");

		// Then: exactly one hidden notice with the exit status and the output tail started one model turn.
		const notices = terminalNotices(harness);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ display: false });
		expect(notices[0]?.content).toBe(
			"<system-reminder>Background terminal session bash_1 finished: completed (exit code 0).\n" +
				"Final output:\nX6_WAKE_TAIL:PING</system-reminder>",
		);
		expect(JSON.stringify(wakeContext?.messages.at(-1))).toContain(
			"Background terminal session bash_1 finished: completed (exit code 0).",
		);
		expect(getAssistantTexts(harness)).toEqual(["", "started", "woke"]);
		expect(getUserTexts(harness)).toEqual(["start the waiter"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});
});
