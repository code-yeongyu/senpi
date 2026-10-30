import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../../src/core/extensions/builtin/hooks/index.ts";
import { HOOK_CUSTOM_MESSAGE_TYPE } from "../../../src/core/extensions/builtin/hooks/prompt-adapter.ts";
import { createHookTrustEntry, hookTrustId } from "../../../src/core/extensions/builtin/hooks/trust.ts";
import { builtinExtensions } from "../../../src/core/extensions/builtin/index.ts";
import { createLoopExtension } from "../../../src/core/extensions/builtin/loop/index.ts";
import type { LoopTimerPort } from "../../../src/core/extensions/builtin/loop/scheduler.ts";
import type { LoopState } from "../../../src/core/extensions/builtin/loop/types.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const MINUTE = 60_000;
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const idleTimers: LoopTimerPort = { arm: () => {}, cancel: () => {}, cancelAll: () => {} };

/** A dynamic loop suspended by a previous process, waiting on a model-scheduled wakeup. */
function suspendedDynamicLoop(sessionId: string, now: number): LoopState {
	return {
		version: 1,
		sessionId,
		activeDynamicId: "loop-1",
		updatedAt: now,
		entries: {
			"loop-1": {
				id: "loop-1",
				kind: "dynamic",
				phase: "suspended",
				originalArgs: "watch the queue",
				reentryPrompt: "/loop watch the queue",
				payload: { type: "prompt", prompt: "watch the queue" },
				createdAt: now - MINUTE,
				lastFiredAt: now - MINUTE,
				expiresAt: now + 7 * 24 * 60 * MINUTE,
				lastScheduledForAt: null,
				coalescedFirePending: false,
				queuedForAt: null,
				noopStreak: 0,
				tickCount: 1,
				sentinelDelivery: {
					autonomousPreambleDelivered: false,
					lastLoopFileDelivered: null,
					forceFullDelivery: false,
				},
				wakeSources: [],
				keepaliveCredit: 1,
				pendingWakeup: {
					id: "wakeup-1",
					loopId: "loop-1",
					kind: "dynamic",
					source: "model",
					requestedDelaySeconds: 1800,
					delaySeconds: 1800,
					dueAt: now + 30 * MINUTE,
					reason: "poll later",
					prompt: "/loop watch the queue",
					noop: false,
					createdAt: now - MINUTE,
				},
			},
		},
	};
}

function writeSessionStartHook(cwd: string): void {
	const script = join(cwd, "session-start-context.mjs");
	writeFileSync(
		script,
		`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Startup context from a SessionStart hook.' } })));`,
	);
	const config = {
		hooks: {
			SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }],
		},
	};
	const sourcePath = join(cwd, ".senpi", "hooks.json");
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	writeFileSync(sourcePath, JSON.stringify(config));
	const parsed = parseHookConfig(config, {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	});
	const hooks = Object.fromEntries(
		parsed.executableHandlers.map((handler) => [
			hookTrustId(handler),
			createHookTrustEntry(handler, { platform: process.platform, updatedAt: "2026-10-18T00:00:00.000Z" }),
		]),
	);
	writeFileSync(join(cwd, ".senpi", "hooks-state.json"), JSON.stringify({ version: 1, hooks }));
}

async function bootedFirstTurn(sizesOnly: boolean) {
	const hooks = builtinExtensions.find((extension) => extension.id === "hooks");
	if (hooks === undefined) throw new Error("builtin hooks extension is not registered");
	const now = Date.now();
	const loop = createLoopExtension({
		clock: { now: () => now },
		timers: () => idleTimers,
		readState: async (ref) => suspendedDynamicLoop(ref.sessionId, now),
		writeState: async () => {},
	});
	const harness = await createHarness({
		extensionFactories: [
			{ path: "<builtin:hooks>", factory: hooks.factory },
			{ path: "<builtin:loop>", factory: loop },
		],
	});
	harnesses.push(harness);
	writeSessionStartHook(harness.tempDir);
	await harness.session.bindExtensions({ mode: "print", sizesOnly });
	const prefix = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.({ sizesOnly: true });
	if (prefix?.status !== "ready") throw new Error(`Expected a ready prefix, got ${JSON.stringify(prefix)}`);
	const local = (text: string) => text.replaceAll(harness.tempDir, "<tmp>");
	return {
		hookContext: harness.session.messages
			.filter((message) => message.role === "custom" && message.customType === HOOK_CUSTOM_MESSAGE_TYPE)
			.map((message) => local(getMessageText(message))),
		activeTools: harness.session.getActiveToolNames().sort(),
		systemPrompt: local(prefix.request.context.systemPrompt ?? ""),
		tools: (prefix.request.context.tools ?? []).map((tool) => tool.name).sort(),
	};
}

describe("sizes-only startup keeps the first turn of a normal startup (#3483)", () => {
	it("runs SessionStart hooks and restores loop tool state exactly like a normal startup", async () => {
		// Given: a trusted SessionStart hook with context and a restored live dynamic loop.
		const normal = await bootedFirstTurn(false);
		// When
		const sizesOnly = await bootedFirstTurn(true);
		// Then: expectations come from the normal startup, which must itself carry both effects.
		expect(normal.hookContext.length).toBeGreaterThan(0);
		expect(normal.activeTools).toContain("schedule_wakeup");
		expect(sizesOnly).toEqual(normal);
	});

	it.each(["sendMessage", "sendUserMessage"] as const)(
		"starts no model turn when a session_start handler calls %s",
		async (api) => {
			// Given: an extension that starts a turn from session_start, as a goal or due loop does.
			const run = async (sizesOnly: boolean) => {
				const harness = await createHarness({
					extensionFactories: [
						{
							path: "/fixture/turn-starter/index.ts",
							factory: (pi: ExtensionAPI) => {
								pi.on("session_start", () => {
									if (api === "sendMessage") {
										pi.sendMessage(
											{ customType: "fixture", content: "continue", display: false },
											{ triggerTurn: true },
										);
									} else {
										pi.sendUserMessage("continue");
									}
								});
							},
						},
					],
				});
				harnesses.push(harness);
				harness.setResponses([fauxAssistantMessage("done")]);
				await harness.session.bindExtensions({ mode: "print", sizesOnly });
				const prefix = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.({
					sizesOnly: true,
				});
				await harness.session.waitForSettledSessionWork();
				await harness.session.waitForIdle();
				return { calls: harness.faux.getCallLog().length, status: prefix?.status };
			};
			// When
			const normal = await run(false);
			const sizesOnly = await run(true);
			// Then: the fixture really reaches the model normally; sizes-only startup never does.
			expect(normal.calls).toBeGreaterThan(0);
			expect(sizesOnly).toEqual({ calls: 0, status: "ready" });
		},
	);

	it("opens no custody and writes no session file for a turn a session_start handler asks for (senpi#3963)", async () => {
		// Given: a persisted session and an extension that asks for a turn from session_start.
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				{
					path: "/fixture/turn-starter/index.ts",
					factory: (pi: ExtensionAPI) => {
						pi.on("session_start", () => {
							pi.sendMessage(
								{ customType: "fixture", content: "continue", display: false },
								{ triggerTurn: true },
							);
						});
					},
				},
			],
		});
		harnesses.push(harness);
		// When: sizes-only startup runs session_start.
		await harness.session.bindExtensions({ mode: "print", sizesOnly: true });
		await harness.session.waitForSettledSessionWork();
		await harness.session.waitForIdle();
		// Then: the inspection owes no work, recorded no custody and created no session file.
		const sessionFile = harness.session.sessionManager.getSessionFile();
		expect({
			calls: harness.faux.getCallLog().length,
			activeObligations: harness.session.workObligations.activeCount,
			custodyEntries: harness.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "work-custody").length,
			sessionFileWritten: sessionFile !== undefined && existsSync(sessionFile),
		}).toEqual({ calls: 0, activeObligations: 0, custodyEntries: 0, sessionFileWritten: false });
	});
});
