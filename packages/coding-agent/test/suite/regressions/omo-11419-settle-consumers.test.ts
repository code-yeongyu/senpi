// oh-my-openagent#11419 follow-up (senpi#4420 review): agent_settled now reaches subscribers before the extension
// agent_settled handlers finish, so it means "the run settled", not "every settle-time job drained". End-of-work
// consumers (TUI shutdown, host idle exit, seal accounting, RPC idle waits) must wait for agent_idle, which follows the
// handlers; and a settled handler that is still running is quiet diagnostics, never a notice the user cannot act on.
import { describe, expect, it, vi } from "vitest";
import { reportExtensionHandlerStall } from "../../../src/core/extension-handler-stall-report.ts";
import type { ExtensionHandlerStall } from "../../../src/core/extensions/handler-budget.ts";
import type { SessionLogger } from "../../../src/core/session-log.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { IdleExitDecider } from "../../../src/modes/rpc/host-lifecycle-policy.ts";
import { holdIdleExitForSettling, SessionRunActivity } from "../../../src/modes/rpc/host-run-activity.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { SessionOpenTurns } from "../../../src/modes/rpc/session-open-turns.ts";

function stall(event: string, stage: ExtensionHandlerStall["stage"]): ExtensionHandlerStall {
	return { extensionPath: "/ext/omo.js", event, stage, elapsedMs: 60_000, timeoutMs: 1_200_000 };
}

function fakeLogger(): { logger: SessionLogger; lines: Array<{ event: string; data: unknown }> } {
	const lines: Array<{ event: string; data: unknown }> = [];
	const logger = { warn: (event: string, data: unknown) => lines.push({ event, data }) } as unknown as SessionLogger;
	return { logger, lines };
}

describe("settled handler stalls are diagnostics, not notices", () => {
	it("logs a slow agent_settled handler without notifying, since the turn no longer waits on it", () => {
		// given a warn-stage stall of an agent_settled handler
		const { logger, lines } = fakeLogger();
		const notify = vi.fn();

		// when it is reported
		reportExtensionHandlerStall(stall("agent_settled", "warn"), logger, notify);

		// then session.log has it and nothing is shown
		expect(lines).toEqual([
			{
				event: "extension_handler_stalled",
				data: expect.objectContaining({ extension: "omo.js", handlerEvent: "agent_settled", stage: "warn" }),
			},
		]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("still shows a slow handler that the turn does wait on", () => {
		// given a warn-stage stall of an agent_start handler
		const { logger } = fakeLogger();
		const notify = vi.fn();

		// when it is reported
		reportExtensionHandlerStall(stall("agent_start", "warn"), logger, notify);

		// then the user is told, as before
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

const WINDOW_MS = 600;
const line = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, sessionId: "s", ...extra });

/** The supervisor's rule: the decider over running turns, held while a settled session is within its settle hold. */
function idleDecision(
	lines: readonly string[],
	settleHoldMs = 60_000,
	onExpired?: (sessionId: string, heldMs: number) => void,
): string {
	let now = 0;
	const runs = new SessionRunActivity({ settleHoldMs, now: () => now, onSettleHoldExpired: onExpired });
	const decider = new IdleExitDecider(WINDOW_MS, () => now);
	const decide = () =>
		holdIdleExitForSettling(decider.update({ connections: 0, activeTurns: runs.busySessions }), runs);
	for (const entry of lines) if (runs.observe(entry)) decide();
	decide();
	now += WINDOW_MS;
	return decide();
}

describe("host idle exit waits for the settle-time handlers, within a bound", () => {
	it("does not exit between agent_settled and agent_idle while the settle hold lasts", () => {
		expect(idleDecision([line("agent_start"), line("agent_settled")])).toBe("idle");
	});

	it("exits once agent_idle says the handlers drained", () => {
		expect(idleDecision([line("agent_start"), line("agent_settled"), line("agent_idle")])).toBe("exit");
	});

	it("exits on the seal's owed settle even though no agent_idle will come", () => {
		expect(
			idleDecision([
				line("agent_start"),
				line("agent_settled"),
				line("agent_settled", { reason: "session_closed" }),
			]),
		).toBe("exit");
	});

	it("exits once the settle hold ran out though the handlers never finished, and says so once", () => {
		// given a hold shorter than the idle window and a session that settled but never went idle
		const expired = vi.fn();

		// when the idle window passes
		const decision = idleDecision([line("agent_start"), line("agent_settled")], WINDOW_MS / 2, expired);

		// then the host may exit, and the expired hold was reported for that session
		expect(decision).toBe("exit");
		expect(expired.mock.calls.map((call) => call[0])).toEqual(["s"]);
	});
});

describe("seal accounting owes a settle until agent_idle", () => {
	it("owes one settle for a run that settled while its handlers still run", () => {
		// given a run that settled but has not gone idle
		const turns = new SessionOpenTurns();
		turns.note("s", "agent_start");
		turns.note("s", "agent_settled");

		// when the session is sealed
		// then the observer is still owed one settle, which releases its busy count
		expect(turns.take("s")).toBe(1);
	});

	it("owes nothing once the session went idle", () => {
		const turns = new SessionOpenTurns();
		turns.note("s", "agent_start");
		turns.note("s", "agent_settled");
		turns.note("s", "agent_idle");
		expect(turns.take("s")).toBe(0);
	});

	it("does not count the seal's own synthetic settle as a new debt", () => {
		const turns = new SessionOpenTurns();
		turns.note("s", "agent_settled", "session_closed");
		expect(turns.take("s")).toBe(0);
	});
});

type ShutdownSurface = {
	isInitialized: boolean;
	footer: { invalidate: () => void };
	agentIdle: boolean;
	pendingUserInputs: unknown[];
	providerErrors: undefined;
	clearStatusIndicator: (kind?: string) => void;
	ui: { requestRender: () => void };
	checkShutdownRequested: () => Promise<void>;
};

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent(event: { type: string }): Promise<void> })
	.handleEvent;

describe("TUI deferred shutdown waits for agent_idle", () => {
	function surface(): ShutdownSurface {
		return {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			agentIdle: false,
			pendingUserInputs: [],
			providerErrors: undefined,
			clearStatusIndicator: vi.fn(),
			ui: { requestRender: vi.fn() },
			checkShutdownRequested: vi.fn(async () => {}),
		};
	}

	it("does not shut down on agent_settled, while settled handlers may still run", async () => {
		const tui = surface();
		await handleEvent.call(tui, { type: "agent_settled" });
		expect(tui.checkShutdownRequested).not.toHaveBeenCalled();
	});

	it("shuts down on agent_idle, after the handlers drained", async () => {
		const tui = surface();
		await handleEvent.call(tui, { type: "agent_idle" });
		expect(tui.checkShutdownRequested).toHaveBeenCalledTimes(1);
	});
});

describe("RpcClient idle waits resolve on agent_idle", () => {
	function feed(client: RpcClient, record: Record<string, unknown>): void {
		(Reflect.get(client, "handleLine") as (line: string) => void).call(client, JSON.stringify(record));
	}

	it("waitForIdle does not resolve on agent_settled, and resolves on agent_idle", async () => {
		// given a client waiting for idle
		const client = new RpcClient({});
		let resolved = false;
		const waiting = client.waitForIdle(5_000).then(() => {
			resolved = true;
		});

		// when the run settles, then goes idle
		feed(client, { type: "agent_settled" });
		await Promise.resolve();
		const afterSettle = resolved;
		feed(client, { type: "agent_idle" });
		await waiting;

		// then only agent_idle ended the wait
		expect(afterSettle).toBe(false);
		expect(resolved).toBe(true);
	});

	it("collectEvents keeps collecting past agent_settled until agent_idle", async () => {
		const client = new RpcClient({});
		const collecting = client.collectEvents(5_000);
		feed(client, { type: "agent_settled" });
		feed(client, { type: "agent_idle" });
		expect((await collecting).map((event) => event.type)).toEqual(["agent_settled", "agent_idle"]);
	});
});
