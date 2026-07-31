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
	}>;
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.find((part) => part.type === "text")?.text ?? "";
}

describe("terminal monitor liveness event", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("publishes active monitor counts when a monitor starts and settles", async () => {
		const states: MonitorStateEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				registerTerminalExtension,
				(pi) => {
					pi.on("session_start", () => {
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
			command: "sleep 30",
			persistent: true,
		});
		const bashId = /bash_\d+/.exec(resultText(started))?.[0];
		if (!bashId) throw new Error("Monitor did not return a bash id");

		try {
			expect(states).toContainEqual({
				activeCount: 1,
				monitors: [
					{
						id: bashId,
						description: "liveness test",
						paused: false,
						startedAtMs: expect.any(Number),
					},
				],
			});
		} finally {
			await harness.session.executeTool("kill_bash", { bash_id: bashId });
		}
		expect(states.at(-1)).toEqual({ activeCount: 0, monitors: [] });
	});
});
