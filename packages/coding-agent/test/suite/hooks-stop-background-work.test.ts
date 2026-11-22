import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { STOP_STATE_CUSTOM_TYPE } from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { STOP_DRAIN_GRACE_MS } from "../../src/core/extensions/builtin/hooks/stop-lifecycle.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const STOP_LOG = "stop-payloads.jsonl";

type StopFixture = {
	readonly harness: Harness;
	readonly publish: (source: string, activeCount: number) => void;
	/** An entry the background work writes into the session (a wake notice), as an extension's `pi.appendEntry`. */
	readonly appendEntry: (customType: string) => void;
	readonly payloads: () => Record<string, unknown>[];
	readonly cleanup: () => void;
};

function hooksExtensionFactory() {
	const extension = builtinExtensions.find((entry) => entry.id === "hooks");
	if (extension === undefined) throw new Error("builtin hooks extension is not registered");
	return extension.factory;
}

function writeStopHookProject(cwd: string, command: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const sourcePath = join(senpiDir, "hooks.json");
	const hookConfig = { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } };
	writeFileSync(sourcePath, `${JSON.stringify(hookConfig, null, 2)}\n`, "utf-8");
	const source = {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	} satisfies HookSourceMetadata;
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of parseHookConfig(hookConfig, source).executableHandlers) {
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-06-29T00:00:00.000Z",
		});
	}
	writeFileSync(join(senpiDir, "hooks-state.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, "utf-8");
}

async function prepareStopFixture(): Promise<StopFixture> {
	const hookDir = join(tmpdir(), `senpi-stop-background-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(hookDir, { recursive: true });
	const logPath = join(hookDir, STOP_LOG);
	const scriptPath = join(hookDir, "stop.mjs");
	writeFileSync(
		scriptPath,
		`import { appendFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { appendFileSync(${JSON.stringify(logPath)}, stdin.trim() + '\\n'); process.stdout.write('{}'); });`,
		"utf-8",
	);
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		extensionFactories: [
			{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" },
			(pi) => {
				api = pi;
			},
		],
	});
	writeStopHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
	return {
		harness,
		publish: (source, activeCount) => {
			if (api === undefined) throw new Error("wake-source publisher was not bound");
			api.events.emit(WAKE_SOURCE_STATE_EVENT, { source, activeCount });
		},
		appendEntry: (customType) => {
			if (api === undefined) throw new Error("the background-work extension was not bound");
			api.appendEntry(customType, { at: "background" });
		},
		payloads: () =>
			existsSync(logPath)
				? readFileSync(logPath, "utf-8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as Record<string, unknown>)
				: [],
		cleanup: () => {
			harness.cleanup();
			rmSync(hookDir, { recursive: true, force: true });
		},
	};
}

function stopDispatchSettled(harness: Harness): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = setTimeout(() => {
			unsubscribe();
			reject(new Error("Stop hook dispatch never settled"));
		}, 10_000);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "entry_appended" || event.entry.type !== "custom") return;
			if (event.entry.customType !== STOP_STATE_CUSTOM_TYPE) return;
			clearTimeout(deadline);
			unsubscribe();
			resolve();
		});
	});
}

describe("builtin hooks Stop while background work is live", () => {
	const fixtures: StopFixture[] = [];

	afterEach(() => {
		vi.useRealTimers();
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("holds Stop while a background wake source is live and reports it once the source drains while idle", async () => {
		// Given
		const fixture = await prepareStopFixture();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("started a monitor")]);
		fixture.publish("terminal-monitors", 1);

		// When
		await fixture.harness.session.prompt("watch the build");

		// Then
		expect(fixture.payloads()).toEqual([]);

		// When
		const settled = stopDispatchSettled(fixture.harness);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fixture.publish("terminal-monitors", 0);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(STOP_DRAIN_GRACE_MS);
		vi.useRealTimers();
		await settled;

		// Then
		expect(fixture.payloads()).toEqual([
			expect.objectContaining({
				cwd: fixture.harness.tempDir,
				event: "Stop",
				hook_event_name: "Stop",
				session_id: fixture.harness.session.sessionId,
			}),
		]);
	});

	// EQ E08, E16, E20 (fused sessions with background work): a held Stop reads its turn key when it dispatches, so the
	// key names the leaf the session has reached by then (entries the background work and its drain appended), not the
	// turn's end. That is the behavior before the hosted-loop port (#6751), measured at 26d5f2e24c: the stop-state
	// entry's key there named its parent entry.
	it("keys a held Stop's state to the session's leaf when the Stop dispatches, not to the turn's end", async () => {
		// Given
		const fixture = await prepareStopFixture();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("started it in the background")]);
		fixture.publish("terminal-background-sessions", 1);
		await fixture.harness.session.prompt("run the build in the background");
		const turnEndLeaf = fixture.harness.session.sessionManager.getLeafId();
		fixture.appendEntry("background-work-notice");

		// When
		const settled = stopDispatchSettled(fixture.harness);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fixture.publish("terminal-background-sessions", 0);
		await vi.advanceTimersByTimeAsync(STOP_DRAIN_GRACE_MS);
		vi.useRealTimers();
		await settled;

		// Then
		const stopStates = fixture.harness.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === STOP_STATE_CUSTOM_TYPE);
		const leafWhenWritten = stopStates[0]?.parentId;
		expect(leafWhenWritten).not.toBe(turnEndLeaf);
		expect(stopStates.map((entry) => (entry.type === "custom" ? entry.data : undefined))).toEqual([
			expect.objectContaining({ turnKey: `1:${leafWhenWritten}`, count: 0 }),
		]);
	});

	it("reports Stop at the turn end when only a pending ask-user question is live", async () => {
		// Given
		const fixture = await prepareStopFixture();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("asked")]);
		fixture.publish("ask-user", 1);

		// When
		await fixture.harness.session.prompt("ask me something");

		// Then
		expect(fixture.payloads()).toEqual([expect.objectContaining({ event: "Stop" })]);
	});

	it("drops the held Stop when the wake turn starts, so that turn reports exactly one Stop", async () => {
		// Given
		const fixture = await prepareStopFixture();
		fixtures.push(fixture);
		fixture.harness.setResponses([
			fauxAssistantMessage("spawned a task"),
			fauxAssistantMessage("task result folded in"),
		]);
		fixture.publish("senpi-task", 1);
		await fixture.harness.session.prompt("delegate it");
		expect(fixture.payloads()).toEqual([]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fixture.publish("senpi-task", 0);
		expect(vi.getTimerCount()).toBe(1);

		// When
		await fixture.harness.getExtensionRunner().emit({ type: "agent_start" });

		// Then
		expect(vi.getTimerCount()).toBe(0);

		// When
		vi.useRealTimers();
		await fixture.harness.session.prompt("the task finished");

		// Then
		expect(fixture.payloads()).toHaveLength(1);
	});

	it("keeps Stop held across a wake turn that ends with the work still live", async () => {
		// Given
		const fixture = await prepareStopFixture();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("armed"), fauxAssistantMessage("still waiting")]);
		fixture.publish("terminal-background-sessions", 1);

		// When
		await fixture.harness.session.prompt("start the server");
		await fixture.harness.session.prompt("check on it");

		// Then
		expect(fixture.payloads()).toEqual([]);
	});
});
