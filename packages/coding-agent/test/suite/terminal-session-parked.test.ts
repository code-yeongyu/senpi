import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import terminalExtension from "../../src/core/extensions/builtin/terminal/extension.ts";
import { FILE_MONITOR_POLL_MS } from "../../src/core/extensions/builtin/terminal/monitor-file-watch.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("stops durable file polling while parked and preserves an explicit mute when resumed", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let polls = 0;
	const schedule = globalThis.setInterval;
	vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) =>
		schedule(() => {
			if (delay === FILE_MONITOR_POLL_MS) polls += 1;
			callback(...args);
		}, delay),
	);
	const h = await createHarness({ extensionFactories: [terminalExtension] });
	const registryCapture = vi.spyOn(MonitorRegistry.prototype, "registerFile");
	const path = join(h.tempDir, "watched.txt");
	await writeFile(path, "original");
	const tool = h
		.getExtensionRunner()
		.getAllRegisteredTools()
		.find((entry) => entry.definition.name === "monitor");
	if (!tool) throw new Error("Missing terminal monitor tool");
	try {
		await tool.definition.execute(
			"monitor-1",
			{ path, event: "modify", persistent: true, description: "poll" },
			undefined,
			undefined,
			h.getExtensionRunner().createContext() as ExtensionToolContext,
		);
		const registry = registryCapture.mock.instances[0];
		if (!(registry instanceof MonitorRegistry)) throw new Error("Missing live monitor registry");
		const second = await registry.registerFile({
			path,
			event: "modify",
			persistent: true,
			description: "muted",
			timeoutMs: 60_000,
			cwd: h.tempDir,
		});
		registry.pause([second.id]);
		await vi.advanceTimersByTimeAsync(FILE_MONITOR_POLL_MS * 2);
		expect(polls).toBe(2);
		await h.getExtensionRunner().emit({ type: "session_parked" });
		await vi.advanceTimersByTimeAsync(FILE_MONITOR_POLL_MS * 4);
		expect(polls).toBe(2);
		await h.getExtensionRunner().emit({ type: "session_resumed" });
		await vi.advanceTimersByTimeAsync(FILE_MONITOR_POLL_MS * 2);
		expect(polls).toBe(4);
		expect(registry.snapshot().find((entry) => entry.id === second.id)?.paused).toBe(true);
	} finally {
		await h.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
		h.cleanup();
	}
});
