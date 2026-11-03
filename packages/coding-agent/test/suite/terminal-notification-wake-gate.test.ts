import { describe, expect, it } from "vitest";
import { MONITOR_NOTIFICATION_CUSTOM_TYPE } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { MonitorNotifier } from "../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import {
	IDLE_WAKE_BASE_DELAY_MS,
	IDLE_WAKE_MAX_DELAY_MS,
	NotificationWakeGate,
} from "../../src/core/extensions/builtin/terminal/notification-wake-gate.ts";
import { TERMINAL_NOTIFICATION_CUSTOM_TYPE } from "../../src/core/extensions/builtin/terminal/notify.ts";
import { FakeScheduler, line } from "./terminal-monitor-notify-harness.ts";

type Sent = {
	readonly message: { customType: string; content: string; display: boolean; details?: unknown };
	readonly options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" };
};

function setup() {
	const scheduler = new FakeScheduler();
	const sent: Sent[] = [];
	const gate = new NotificationWakeGate((message, options) => sent.push({ message, options }), scheduler);
	const wakes = () => sent.filter((entry) => entry.options.triggerTurn);
	const idleTurn = () => {
		gate.noteTurnStart();
		gate.noteTurnEnd();
	};
	const notify = (content: string, customType = MONITOR_NOTIFICATION_CUSTOM_TYPE, details?: unknown) =>
		gate.sendMessage(
			{ customType, content, display: false, ...(details === undefined ? {} : { details }) },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	return { scheduler, sent, gate, wakes, idleTurn, notify };
}

describe("notification wake gate: idle sessions back off instead of waking per notification", () => {
	it("coalesces a burst after idle replies into one wake at the backoff, keeping every notification", () => {
		const { scheduler, wakes, idleTurn, notify } = setup();
		idleTurn();
		idleTurn();
		for (let gateLine = 1; gateLine <= 5; gateLine++) {
			notify(`gate ${gateLine}/5`);
			scheduler.advanceBy(3_000);
		}
		expect(wakes()).toHaveLength(0);
		scheduler.advanceBy(IDLE_WAKE_BASE_DELAY_MS);
		expect(wakes()).toHaveLength(1);
		const [wake] = wakes();
		for (let gateLine = 1; gateLine <= 5; gateLine++) expect(wake?.message.content).toContain(`gate ${gateLine}/5`);
	});

	it("doubles the backoff per further idle turn up to the ceiling", () => {
		const { gate, idleTurn } = setup();
		idleTurn();
		expect(gate.backoffMs()).toBe(0);
		idleTurn();
		expect(gate.backoffMs()).toBe(IDLE_WAKE_BASE_DELAY_MS);
		idleTurn();
		expect(gate.backoffMs()).toBe(IDLE_WAKE_BASE_DELAY_MS * 2);
		for (let turn = 0; turn < 10; turn++) idleTurn();
		expect(gate.backoffMs()).toBe(IDLE_WAKE_MAX_DELAY_MS);
	});

	it("wakes at once while the last turns used tools, and a tool call ends the backoff", () => {
		const { gate, scheduler, wakes, idleTurn, notify } = setup();
		notify("first");
		expect(wakes()).toHaveLength(1);
		idleTurn();
		idleTurn();
		gate.noteTurnStart();
		gate.noteToolCall();
		gate.noteTurnEnd();
		scheduler.advanceBy(1);
		notify("after tool use");
		expect(wakes()).toHaveLength(2);
	});

	it("wakes at once when the backoff since the last turn has already passed", () => {
		const { scheduler, wakes, idleTurn, notify } = setup();
		idleTurn();
		idleTurn();
		scheduler.advanceBy(IDLE_WAKE_BASE_DELAY_MS);
		notify("late");
		expect(wakes()).toHaveLength(1);
	});

	it("steers held notifications into a turn that starts for another reason, with no extra wake", () => {
		const { gate, scheduler, sent, idleTurn, notify } = setup();
		idleTurn();
		idleTurn();
		notify("held a");
		notify("held b", TERMINAL_NOTIFICATION_CUSTOM_TYPE);
		gate.noteUserInput();
		gate.noteTurnStart();
		expect(sent.map((entry) => [entry.message.content, entry.options.deliverAs])).toEqual([
			["held a", "steer"],
			["held b", "steer"],
		]);
		scheduler.advanceBy(IDLE_WAKE_MAX_DELAY_MS);
		expect(sent).toHaveLength(2);
	});

	it("passes notifications through untouched while a turn runs", () => {
		const { gate, sent, idleTurn, notify } = setup();
		idleTurn();
		idleTurn();
		gate.noteTurnStart();
		notify("during turn");
		expect(sent).toEqual([
			{
				message: { customType: MONITOR_NOTIFICATION_CUSTOM_TYPE, content: "during turn", display: false },
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	it("never holds a monitor delivery carrying a person's words, and sends held notifications with it", () => {
		const { gate, wakes, idleTurn, notify } = setup();
		idleTurn();
		idleTurn();
		notify("ci line", MONITOR_NOTIFICATION_CUSTOM_TYPE, {
			monitors: [{ id: "mon_ci", description: "ci", eventCount: 1, kinds: ["line"] }],
		});
		notify("the person replied", MONITOR_NOTIFICATION_CUSTOM_TYPE, {
			monitors: [{ id: "mon_chat", description: "chat", eventCount: 1, kinds: ["line"], humanInput: true }],
		});
		expect(wakes()).toHaveLength(1);
		const [wake] = wakes();
		expect(wake?.message.content).toBe("ci line\n\nthe person replied");
		expect(wake?.message.details).toEqual({
			monitors: [
				{ id: "mon_ci", description: "ci", eventCount: 1, kinds: ["line"] },
				{ id: "mon_chat", description: "chat", eventCount: 1, kinds: ["line"], humanInput: true },
			],
		});
		expect(gate.backoffMs()).toBe(0);
	});

	it("drives a MonitorNotifier burst with idle replies into one coalesced wake", () => {
		const scheduler = new FakeScheduler();
		const sent: Sent[] = [];
		const gate = new NotificationWakeGate((message, options) => sent.push({ message, options }), scheduler);
		const notifier = new MonitorNotifier({
			sendMessage: gate.sendMessage,
			getContext: () => ({ mode: "tui", model: { id: "mock", api: "openai-completions" } }) as never,
			getMode: () => "wake",
			getSettings: () => ({
				coalesceWindowMs: 2000,
				rateLimitMs: 5000,
				maxLinesPerInjection: 50,
				maxCharsPerInjection: 4096,
				wakeBudget: 100,
				wakesPerHour: 12,
			}),
			pauseMonitors: () => [],
			scheduler,
		});
		const linesSent = 8;
		let answered = 0;
		// Every wake the session takes is answered without a tool call.
		const answerWakes = () => {
			for (; answered < sent.length; answered++) {
				gate.noteTurnStart();
				gate.noteTurnEnd();
			}
		};
		for (let index = 1; index <= linesSent; index++) {
			notifier.notifyEvent(line(`bash_${index}`, "push gates", `gate ${index}/${linesSent}`));
			scheduler.advanceBy(2_500);
			answerWakes();
		}
		scheduler.advanceBy(IDLE_WAKE_MAX_DELAY_MS);
		answerWakes();
		const wakes = sent.filter((entry) => entry.options.triggerTurn);
		expect(wakes).toHaveLength(3);
		const delivered = wakes.map((entry) => entry.message.content).join("\n");
		for (let index = 1; index <= linesSent; index++) expect(delivered).toContain(`gate ${index}/${linesSent}`);
	});
});
