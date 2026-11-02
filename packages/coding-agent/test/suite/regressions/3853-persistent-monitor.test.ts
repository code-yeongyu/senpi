import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MonitorNotifier } from "../../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import { MonitorRegistry } from "../../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createHarness } from "../harness.ts";
import { FakeScheduler } from "../terminal-monitor-notify-harness.ts";

// senpi#3853: a restored persistent watch uses the real registry/notifier path into a held session.
it("holds a persistent monitor restore event without a provider request", async () => {
	let context: ExtensionContext | undefined;
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
		],
	});
	const scheduler = new FakeScheduler();
	const deliveries: Promise<void>[] = [];
	const notifier = new MonitorNotifier({
		sendMessage: (message, options) => {
			deliveries.push(h.session.sendCustomMessage(message, options));
		},
		getContext: () => context,
		getMode: () => "wake",
		getSettings: () => ({
			coalesceWindowMs: 1,
			rateLimitMs: 1,
			maxLinesPerInjection: 50,
			maxCharsPerInjection: 4096,
			wakeBudget: 5,
			wakesPerHour: 12,
		}),
		pauseMonitors: () => [],
		scheduler,
	});
	const registry = new MonitorRegistry((event) => notifier.notifyEvent(event));
	try {
		await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
		const path = join(h.session.cwd, "watched.txt");
		await writeFile(path, "before");
		const { id } = await registry.registerFile({
			description: "restored watch",
			path,
			event: "modify",
			persistent: true,
			timeoutMs: 30_000,
			cwd: h.session.cwd,
		});
		expect(registry.snapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ id, persistent: true })]));
		// This is the same entry point used to report a checkpoint change found during restore.
		expect(registry.emitFileLine(id, "Changed while the session was offline")).toBe(true);
		scheduler.advanceBy(1);
		await Promise.all(deliveries);
		expect(deliveries).toHaveLength(1);
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.pausedNoticeCount).toBe(1);
		expect(h.session.holds[0]?.sourceCounts).toEqual({ monitor: 1 });
	} finally {
		notifier.dispose();
		registry.dispose();
		h.cleanup();
	}
});
