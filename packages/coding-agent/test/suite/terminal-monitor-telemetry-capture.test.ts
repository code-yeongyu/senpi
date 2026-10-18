import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import {
	isTerminalMonitorEndedEvent,
	isTerminalMonitorStateEvent,
	type TerminalMonitorEndedEvent,
	type TerminalMonitorStateEvent,
} from "../../src/core/extensions/builtin/monitor-state-event.ts";
import registerTerminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import { createHarness } from "./harness.ts";

it("captures real monitor extension events and the persisted notification join", async () => {
	const states: TerminalMonitorStateEvent[] = [];
	const endings: TerminalMonitorEndedEvent[] = [];
	const harness = await createHarness({
		extensionFactories: [
			registerTerminalExtension,
			(pi) => {
				pi.events.on("terminal_monitor_state", (data) => {
					if (isTerminalMonitorStateEvent(data)) states.push(data);
				});
				pi.events.on("terminal_monitor_ended", (data) => {
					if (isTerminalMonitorEndedEvent(data)) endings.push(data);
				});
			},
		],
	});
	let unsubscribe = () => {};
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		harness.setResponses([fauxAssistantMessage("acknowledged")]);
		await harness.session.bindExtensions({ mode: "rpc" });
		const delivered = new Promise<void>((resolve, reject) => {
			timeout = setTimeout(() => reject(new Error("Monitor notification did not complete its turn")), 10_000);
			unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "agent_end") resolve();
			});
		});
		const result = await harness.session.executeTool("monitor", {
			description: "capture telemetry",
			command: "printf 'READY\\n'",
			filter: "^READY$",
		});
		await delivered;
		expect(result.details).toMatchObject({ monitor: true });
		const id = (result.details as { bash_id: string }).bash_id;
		expect(endings).toHaveLength(1);
		expect(endings[0]).toMatchObject({ id, reason: "exit", exitCode: 0, fireCount: 2 });
		const state = states.find((state) =>
			state.monitors?.some((monitor) => monitor.id === id && monitor.fireCount === 1),
		);
		expect(state?.monitors?.[0]).toMatchObject({
			command: "printf 'READY\\n'",
			filter: "^READY$",
			persistent: false,
			fireCount: 1,
			deadlineMs: expect.any(Number),
			lastFiredAtMs: expect.any(Number),
		});
		const notification = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "senpi-monitor:notification");
		expect(notification).toMatchObject({
			details: { monitors: [{ id, description: "capture telemetry", eventCount: 2, kinds: ["line", "summary"] }] },
		});
		const fixturePath = process.env.SENPI_MONITOR_TELEMETRY_FIXTURE;
		if (fixturePath) {
			writeFileSync(
				fixturePath,
				`${JSON.stringify({ terminal_monitor_state: state, terminal_monitor_ended: endings[0], notification_custom_message: notification }, null, 2)}\n`,
			);
		}
	} finally {
		if (timeout) clearTimeout(timeout);
		unsubscribe();
		await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
}, 15_000);
