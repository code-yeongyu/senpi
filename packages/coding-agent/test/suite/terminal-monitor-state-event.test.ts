import { afterEach, describe, expect, it } from "vitest";
import registerTerminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import { createHarness, type Harness } from "./harness.ts";

interface MonitorStateEvent {
	readonly activeCount?: number;
	readonly monitors?: Array<{
		readonly id: string;
		readonly description: string;
		readonly paused: boolean;
		readonly startedAtMs: number;
		readonly command: string | null;
		readonly filter: string | null;
		readonly persistent: boolean;
		readonly deadlineMs: number | null;
		readonly fireCount: number;
		readonly lastFiredAtMs: number | null;
	}>;
}

interface MonitorEndedEvent {
	readonly id: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly reason: "exit" | "timeout" | "killed" | "disposed";
	readonly exitCode: number | null;
	readonly fireCount: number;
}

describe("terminal monitor liveness event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("publishes active monitor counts when a monitor starts and settles", async () => {
		const states: MonitorStateEvent[] = [];
		const ended: MonitorEndedEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				registerTerminalExtension,
				(pi) => {
					pi.on("session_start", () => {
						pi.events.on("terminal_monitor_ended", (data) => {
							ended.push(data as MonitorEndedEvent);
						});
						pi.events.on("terminal_monitor_state", (data) => {
							if (
								typeof data === "object" &&
								data !== null &&
								"activeCount" in data &&
								typeof data.activeCount === "number"
							) {
								const monitors =
									"monitors" in data && Array.isArray(data.monitors)
										? (data.monitors as MonitorStateEvent["monitors"])
										: undefined;
								states.push({ activeCount: data.activeCount, ...(monitors === undefined ? {} : { monitors }) });
							}
						});
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const started = await harness.session.executeTool("monitor", {
			description: "liveness test",
			command: "cat",
			persistent: true,
		});
		const bashId = String((started.details as { bash_id?: string } | undefined)?.bash_id ?? "");
		if (!/^bash_\d+$/.test(bashId)) throw new Error("Monitor did not return a bash id");

		try {
			expect(states).toContainEqual({
				activeCount: 1,
				monitors: [
					{
						id: bashId,
						description: "liveness test",
						paused: false,
						startedAtMs: expect.any(Number),
						command: "cat",
						filter: null,
						persistent: true,
						deadlineMs: null,
						fireCount: 0,
						lastFiredAtMs: null,
					},
				],
			});
		} finally {
			await harness.session.executeTool("kill_bash", { bash_id: bashId });
		}
		expect(states.at(-1)).toEqual({ activeCount: 0, monitors: [] });
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({
			id: bashId,
			description: "liveness test",
			reason: "killed",
			fireCount: 1,
		});
	});

	it("emits terminal_monitor_state over pi.rpc.emit when a monitor starts", async () => {
		const rpcEvents: Array<{ name: string; data: unknown }> = [];
		const harness = await createHarness({
			extensionFactories: [registerTerminalExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const unsubscribe = harness.getExtensionRunner().onRpcEvent((event) => {
			rpcEvents.push(event);
		});

		try {
			const started = await harness.session.executeTool("monitor", {
				description: "rpc liveness test",
				command: "cat",
				persistent: true,
			});
			const bashId = String((started.details as { bash_id?: string } | undefined)?.bash_id ?? "");
			if (!/^bash_\d+$/.test(bashId)) throw new Error("Monitor did not return a bash id");

			try {
				expect(rpcEvents).toContainEqual({
					name: "terminal_monitor_state",
					data: {
						activeCount: 1,
						monitors: [
							{
								id: bashId,
								description: "rpc liveness test",
								paused: false,
								startedAtMs: expect.any(Number),
								command: "cat",
								filter: null,
								persistent: true,
								deadlineMs: null,
								fireCount: 0,
								lastFiredAtMs: null,
							},
						],
					},
				});
			} finally {
				await harness.session.executeTool("kill_bash", { bash_id: bashId });
			}
		} finally {
			unsubscribe();
		}
	});

	it("replays the current monitor and wake state to a late RPC subscriber only", async () => {
		const harness = await createHarness({ extensionFactories: [registerTerminalExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const runner = harness.getExtensionRunner();
		const early: string[] = [];
		const unsubscribeEarly = runner.onRpcEvent(({ name }) => early.push(name));
		try {
			const started = await harness.session.executeTool("monitor", {
				description: "late subscriber",
				command: "cat",
				persistent: true,
			});
			const bashId = String((started.details as { bash_id?: string } | undefined)?.bash_id ?? "");
			try {
				const beforeSubscribe = early.length;
				const late: Array<{ name: string; data: unknown }> = [];
				const unsubscribeLate = runner.onRpcEvent((event) => late.push(event));
				try {
					for (const name of ["terminal_monitor_state", "wake_source_state"]) {
						const active = late.filter(
							(event) =>
								event.name === name &&
								typeof event.data === "object" &&
								event.data !== null &&
								"activeCount" in event.data &&
								event.data.activeCount === 1,
						);
						expect(active, name).toHaveLength(1);
						expect(active[0]?.data).toMatchObject({
							monitors: [expect.objectContaining({ description: "late subscriber" })],
						});
					}
					// The background-session source replays too, as its own row even with no live session.
					const background = late.filter(
						(event) =>
							event.name === "wake_source_state" &&
							typeof event.data === "object" &&
							event.data !== null &&
							"source" in event.data &&
							event.data.source === "terminal-background-sessions",
					);
					expect(background).toHaveLength(1);
					expect(background[0]?.data).toMatchObject({ activeCount: 0, items: [] });
					expect(early.slice(beforeSubscribe)).not.toContain("terminal_monitor_state");
					expect(early.slice(beforeSubscribe)).not.toContain("wake_source_state");
				} finally {
					unsubscribeLate();
				}
			} finally {
				await harness.session.executeTool("kill_bash", { bash_id: bashId });
			}
		} finally {
			unsubscribeEarly();
		}
	});

	it("replays a live background session to a late RPC subscriber with its source and items", async () => {
		const harness = await createHarness({ extensionFactories: [registerTerminalExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const runner = harness.getExtensionRunner();
		const started = await harness.session.executeTool("bash", { command: "cat", run_in_background: true });
		const bashId = String((started.details as { bash_id?: string } | undefined)?.bash_id ?? "");
		expect(bashId).not.toBe("");
		try {
			const late: Array<{ name: string; data: unknown }> = [];
			const unsubscribeLate = runner.onRpcEvent((event) => late.push(event));
			try {
				const background = late.filter(
					(event) =>
						event.name === "wake_source_state" &&
						typeof event.data === "object" &&
						event.data !== null &&
						"source" in event.data &&
						event.data.source === "terminal-background-sessions",
				);
				expect(background).toHaveLength(1);
				expect(background[0]?.data).toMatchObject({
					source: "terminal-background-sessions",
					activeCount: 1,
					items: [expect.objectContaining({ id: bashId })],
				});
			} finally {
				unsubscribeLate();
			}
		} finally {
			await harness.session.executeTool("kill_bash", { bash_id: bashId });
		}
	});
});
