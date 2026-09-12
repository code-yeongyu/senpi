/**
 * `/loop` command tests: registration metadata, the fixed/dynamic/bare start surfaces,
 * stop/pause/resume/status subcommands, usage on invalid input, print-mode rejection,
 * and slash-payload dispatch through the real command path.
 *
 * Everything runs through `createHarness` with the real loop extension factory, so the
 * command handler is exercised exactly as `session.prompt("/loop ...")` drives it.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import loopExtension from "../../src/core/extensions/builtin/loop/index.ts";
import { loopStateFilePath, readLoopState } from "../../src/core/extensions/builtin/loop/store.ts";
import type { CronEntry, LoopState, LoopStoreRef } from "../../src/core/extensions/builtin/loop/types.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

interface CapturedNotice {
	readonly message: string;
	readonly type: string | undefined;
}

interface LoopHarness {
	readonly harness: Harness;
	readonly notices: CapturedNotice[];
	readonly statuses: Array<string | undefined>;
	readonly storeRef: LoopStoreRef;
	noticesText(): string;
	store(): Promise<LoopState | null>;
}

const harnesses: LoopHarness[] = [];

function createUi(notices: CapturedNotice[], statuses: Array<string | undefined>): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => notices.push({ message, type }),
		onTerminalInput: () => () => {},
		setStatus: (_key: string, text: string | undefined) => statuses.push(text),
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

async function createLoopHarness(
	options: { mode?: "tui" | "print"; loopFileContent?: string } = {},
): Promise<LoopHarness> {
	const harness = await createHarness({ extensionFactories: [loopExtension], persistSession: true });
	const notices: CapturedNotice[] = [];
	const statuses: Array<string | undefined> = [];
	await harness.session.bindExtensions({ mode: options.mode ?? "tui", uiContext: createUi(notices, statuses) });
	if (options.loopFileContent !== undefined) {
		const configDir = join(harness.tempDir, CONFIG_DIR_NAME);
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "loop.md"), options.loopFileContent, "utf8");
	}
	const loop: LoopHarness = {
		harness,
		notices,
		statuses,
		storeRef: {
			baseDir: join(harness.sessionManager.getSessionDir(), "extensions", "loop"),
			sessionId: harness.sessionManager.getSessionId(),
		},
		noticesText: () => notices.map((notice) => notice.message).join("\n"),
		store: () => readLoopState(loop.storeRef),
	};
	harnesses.push(loop);
	return loop;
}

/** Waits for a state change with a bounded deadline; never a fixed sleep. */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function prompt(loop: LoopHarness, text: string): Promise<void> {
	await loop.harness.session.prompt(text);
}

/** Arms a fixed loop and waits until its first tick produced a model response. */
async function armFixedLoop(loop: LoopHarness, args: string, marker: string): Promise<string> {
	loop.harness.setResponses([fauxAssistantMessage(`done: ${marker}`)]);
	await prompt(loop, `/loop ${args}`);
	await waitFor(
		() => getAssistantTexts(loop.harness).some((text) => text.includes(`done: ${marker}`)),
		`first tick of /loop ${args}`,
	);
	return expectLoopId(loop, "scheduled");
}

function expectLoopId(loop: LoopHarness, keyword: string): string {
	const pattern = new RegExp(`Loop (\\S+) ${keyword}`);
	let found = "";
	for (const notice of loop.notices) {
		const match = pattern.exec(notice.message);
		if (match !== null) found = match[1];
	}
	expect(found, `expected a "Loop <id> ${keyword}" notice`).toBeTruthy();
	return found;
}

function activeEntries(entries: Record<string, CronEntry>): CronEntry[] {
	return Object.values(entries).filter((entry) => entry.phase !== "ended");
}

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.harness.cleanup();
});

describe("/loop command", () => {
	it("registers with a description, the documented argument hint, and subcommand completions", async () => {
		const loop = await createLoopHarness();
		const command = loop.harness
			.getExtensionRunner()
			.getRegisteredCommands()
			.find((item) => item.name === "loop");
		expect(command, "expected /loop to be registered").toBeDefined();
		expect(command?.description).toBeTruthy();
		expect(command?.argumentHint).toBe("[interval] [prompt] | stop [id|all] | status | pause | resume");

		const completions = (await command?.getArgumentCompletions?.("")) ?? null;
		expect(completions?.map((item) => item.value)).toEqual(["stop", "status", "pause", "resume"]);
		expect((await command?.getArgumentCompletions?.("st"))?.map((item) => item.value)).toEqual(["stop", "status"]);
		expect((await command?.getArgumentCompletions?.("pause"))?.map((item) => item.value)).toEqual(["pause"]);
		expect(await command?.getArgumentCompletions?.("zzz")).toBeNull();
	});

	it("/loop 5m ping confirms cadence, id, expiry, and stop command, then ticks immediately", async () => {
		const loop = await createLoopHarness();
		const loopId = await armFixedLoop(loop, "5m ping", "ping");

		const text = loop.noticesText();
		expect(text).toContain(`Loop ${loopId} scheduled as \`*/5 * * * *\` (every 5 minutes).`);
		expect(text).toContain("It expires automatically at");
		expect(text).toContain("(7 days)");
		expect(text).toContain(`Stop it with \`/loop stop ${loopId}\`.`);
		expect(text).toContain("Running the first tick now.");
		// A clean interval must not claim rounding.
		expect(text).not.toContain("rounds to");

		// The first tick reached the model immediately, carrying the verbatim prompt.
		const tickText = getUserTexts(loop.harness).at(-1) ?? "";
		expect(tickText).toContain("ping");
		expect(tickText).toContain("do not call `schedule_wakeup`");

		// The schedule was persisted and armed before that dispatch.
		const state = await loop.store();
		const entry = state?.entries[loopId];
		expect(entry?.kind).toBe("fixed");
		expect(entry?.phase === "ended").toBe(false);
		expect(entry?.payload).toEqual({ type: "prompt", prompt: "ping" });
		expect((entry as { nextFireAt?: number }).nextFireAt).toBeGreaterThan(0);
		expect(loop.harness.sessionManager.getSessionId()).toBe(state?.sessionId);
	});

	it("/loop 90m ping reports the rounding to 2 hours naming both values", async () => {
		const loop = await createLoopHarness();
		const loopId = await armFixedLoop(loop, "90m ping", "rounding");

		const text = loop.noticesText();
		expect(text).toContain(`Loop ${loopId} scheduled as \`0 */2 * * *\` (every 2 hours; requested 90m).`);
		expect(text).toContain("Requested 90m rounds to 2 hours.");
	});

	it("/loop ping starts dynamic mode and a second /loop reports superseding the first", async () => {
		const loop = await createLoopHarness();
		loop.harness.setResponses([fauxAssistantMessage("dyn one"), fauxAssistantMessage("dyn two")]);
		await prompt(loop, "/loop ping");
		await waitFor(
			() => getAssistantTexts(loop.harness).some((text) => text.includes("dyn one")),
			"first dynamic tick",
		);
		const firstId = expectLoopId(loop, "started");

		await prompt(loop, "/loop other");
		await waitFor(
			() => getAssistantTexts(loop.harness).some((text) => text.includes("dyn two")),
			"second dynamic tick",
		);
		const secondId = expectLoopId(loop, "started");

		expect(secondId).not.toBe(firstId);
		expect(loop.noticesText()).toContain(`Superseded dynamic loop ${firstId}.`);

		const state = await loop.store();
		const active = state ? activeEntries(state.entries) : [];
		expect(active).toHaveLength(1);
		expect(active[0]?.kind).toBe("dynamic");
		expect(active[0]?.payload).toEqual({ type: "prompt", prompt: "other" });
		expect(state?.entries[firstId]?.phase).toBe("ended");
	});

	it("bare /loop with a loop file uses the loop.md-dynamic sentinel and delivers the file", async () => {
		const loop = await createLoopHarness({ loopFileContent: "WORK THE LOOP FILE TASKS" });
		loop.harness.setResponses([fauxAssistantMessage("bare file done")]);
		await prompt(loop, "/loop");
		await waitFor(
			() => getAssistantTexts(loop.harness).some((text) => text.includes("bare file done")),
			"bare tick with loop file",
		);

		const tickText = getUserTexts(loop.harness).at(-1) ?? "";
		expect(tickText).toContain("# /loop tick - loop.md tasks");
		expect(tickText).toContain("WORK THE LOOP FILE TASKS");
		expect(tickText).toContain("schedule_wakeup");

		const state = await loop.store();
		const active = state ? activeEntries(state.entries) : [];
		expect(active).toHaveLength(1);
		expect(active[0]?.payload).toEqual({ type: "sentinel", sentinel: "<<loop.md-dynamic>>" });
	});

	it("bare /loop without a loop file uses the autonomous-dynamic sentinel", async () => {
		const loop = await createLoopHarness();
		loop.harness.setResponses([fauxAssistantMessage("bare autonomous done")]);
		await prompt(loop, "/loop");
		await waitFor(
			() => getAssistantTexts(loop.harness).some((text) => text.includes("bare autonomous done")),
			"bare tick without loop file",
		);

		const tickText = getUserTexts(loop.harness).at(-1) ?? "";
		expect(tickText).toContain("# Autonomous loop tick (dynamic pacing)");
		expect(tickText).not.toContain("loop.md tasks");

		const state = await loop.store();
		const active = state ? activeEntries(state.entries) : [];
		expect(active).toHaveLength(1);
		expect(active[0]?.payload).toEqual({ type: "sentinel", sentinel: "<<autonomous-loop-dynamic>>" });
	});

	it("/loop 5m (interval only) is treated as bare fixed, not invalid", async () => {
		const loop = await createLoopHarness();
		loop.harness.setResponses([fauxAssistantMessage("bare fixed done")]);
		await prompt(loop, "/loop 5m");
		await waitFor(
			() => getAssistantTexts(loop.harness).some((text) => text.includes("bare fixed done")),
			"bare fixed tick",
		);

		const text = loop.noticesText();
		expect(text).not.toContain("Usage: /loop");
		expect(text).toContain("Loop ");
		expect(text).toContain("started (fixed");

		const state = await loop.store();
		const active = state ? activeEntries(state.entries) : [];
		expect(active).toHaveLength(1);
		expect(active[0]?.kind).toBe("fixed");
		expect(active[0]?.payload).toEqual({ type: "sentinel", sentinel: "<<autonomous-loop>>" });

		const tickText = getUserTexts(loop.harness).at(-1) ?? "";
		expect(tickText).toContain("# Autonomous loop tick\n");
	});

	it("/loop stop with one active loop stops it", async () => {
		const loop = await createLoopHarness();
		const loopId = await armFixedLoop(loop, "5m ping", "single-stop");

		await prompt(loop, "/loop stop");
		await waitFor(() => loop.notices.some((n) => n.message.includes("Stopped")), "stop notice");

		expect(loop.noticesText()).toContain(`Stopped loop ${loopId}.`);
		const state = await loop.store();
		expect(state?.entries[loopId]?.phase).toBe("ended");
		expect(state?.entries[loopId]?.endReason).toBe("stopped");
	});

	it("/loop stop with several active loops lists the ids and stops nothing", async () => {
		const loop = await createLoopHarness();
		const first = await armFixedLoop(loop, "5m ping", "multi-a");
		const second = await armFixedLoop(loop, "3m pong", "multi-b");

		await prompt(loop, "/loop stop");
		await waitFor(
			() => loop.notices.some((n) => n.message.includes("Multiple loops are active")),
			"disambiguation notice",
		);

		const text = loop.noticesText();
		expect(text).toContain(first);
		expect(text).toContain(second);
		expect(text).toContain("/loop stop <id>");
		expect(text).toContain("/loop stop all");

		const state = await loop.store();
		expect(state?.entries[first]?.phase).not.toBe("ended");
		expect(state?.entries[second]?.phase).not.toBe("ended");
	});

	it("/loop stop all stops every active loop", async () => {
		const loop = await createLoopHarness();
		const first = await armFixedLoop(loop, "5m ping", "stopall-a");
		const second = await armFixedLoop(loop, "3m pong", "stopall-b");

		await prompt(loop, "/loop stop all");
		await waitFor(() => loop.notices.some((n) => n.message.includes("Stopped 2 loops")), "stop all notice");

		const state = await loop.store();
		expect(state?.entries[first]?.phase).toBe("ended");
		expect(state?.entries[second]?.phase).toBe("ended");
		expect(state?.entries[first]?.endReason).toBe("stopped");
	});

	it("/loop stop <unknown-id> is reported, never silently ignored", async () => {
		const loop = await createLoopHarness();
		const loopId = await armFixedLoop(loop, "5m ping", "unknown-id");

		await prompt(loop, "/loop stop does-not-exist");
		await waitFor(() => loop.notices.some((n) => n.message.includes("does-not-exist")), "unknown id notice");

		const text = loop.noticesText();
		expect(text).toContain('No active loop with id "does-not-exist".');
		expect(text).toContain(loopId);
		const state = await loop.store();
		expect(state?.entries[loopId]?.phase).not.toBe("ended");
	});

	it("/loop status lists every active loop with the status-line affordance", async () => {
		const loop = await createLoopHarness();
		const loopId = await armFixedLoop(loop, "5m ping", "status");

		await prompt(loop, "/loop status");
		await waitFor(() => loop.notices.some((n) => n.message.includes("Active loops")), "status notice");

		const text = loop.noticesText();
		expect(text).toContain("Loop (fixed): next in");
		expect(text).toContain("/loop stop");
		expect(text).toContain(loopId);
		expect(text).toContain("`*/5 * * * *`");
		expect(text).toContain("every 5 minutes");

		const withTwo = loop;
		await armFixedLoop(withTwo, "3m pong", "status-two");
		await prompt(withTwo, "/loop status");
		await waitFor(
			() => withTwo.notices.filter((n) => n.message.includes("Active loops")).length >= 2,
			"second status notice",
		);
		const secondStatus = withTwo.notices.filter((n) => n.message.includes("Active loops")).at(-1)?.message ?? "";
		expect(secondStatus).toContain(loopId);
	});

	it("/loop pause then /loop resume round-trips a single loop", async () => {
		const loop = await createLoopHarness();
		const loopId = await armFixedLoop(loop, "5m ping", "pause-resume");

		await prompt(loop, "/loop pause");
		await waitFor(() => loop.notices.some((n) => n.message.includes("Paused")), "pause notice");
		expect(loop.noticesText()).toContain(`Paused loop ${loopId}.`);
		expect((await loop.store())?.entries[loopId]?.phase).toBe("suspended");

		await prompt(loop, "/loop resume");
		await waitFor(() => loop.notices.some((n) => n.message.includes("Resumed")), "resume notice");
		expect(loop.noticesText()).toContain(`Resumed loop ${loopId}.`);
		const resumed = (await loop.store())?.entries[loopId];
		expect(resumed?.phase).not.toBe("ended");
		expect(resumed?.phase).not.toBe("suspended");
	});

	it("invalid input prints the ported usage block and arms nothing", async () => {
		const loop = await createLoopHarness();
		await prompt(loop, "/loop 0m bogusarg");

		const text = loop.noticesText();
		expect(text).toContain("Usage: /loop [interval] <prompt>");
		expect(text).toContain("/loop 5m check the deploy");
		expect(text).toContain("/loop check the deploy every 20m");
		expect(text).toContain("/loop stop [id|all]");
		expect(text).toContain("/loop status");
		expect(text).toContain("/loop pause [id|all]");
		expect(text).toContain("/loop resume [id|all]");

		expect(await loop.store()).toBeNull();
		expect(getUserTexts(loop.harness)).toHaveLength(0);
	});

	it("print mode rejects with a one-line interactive-only message and arms nothing", async () => {
		const loop = await createLoopHarness({ mode: "print" });
		await prompt(loop, "/loop 5m ping");

		const rejection = loop.notices.find((n) => n.message.includes("interactive"));
		expect(rejection, `expected an interactive-only rejection, got: ${loop.noticesText()}`).toBeDefined();
		expect(rejection?.message.includes("\n")).toBe(false);
		expect(rejection?.type).toBe("warning");

		expect(await loop.store()).toBeNull();
		expect(getUserTexts(loop.harness)).toHaveLength(0);
		expect(getAssistantTexts(loop.harness)).toHaveLength(0);
		expect(loopStatusFileExists(loop)).toBe(false);
	});

	it("print-mode rejection reaches a real output channel, not only ctx.ui.notify", async () => {
		// Regression: headless hosts install `noOpUIContext` (runner.ts), whose notify() is a literal
		// no-op. This suite injects a capturing UI, so a notify-only rejection passes here while the
		// real `-p` run prints nothing at all and exits 0 - violating Scope 18's "clear message".
		// stderr is the right channel: takeOverStdout() reserves real stdout for -p result data.
		const written: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let loop: LoopHarness;
		try {
			loop = await createLoopHarness({ mode: "print" });
			await prompt(loop, "/loop 5m ping");
		} finally {
			process.stderr.write = originalWrite;
		}

		const emitted = written.join("");
		expect(emitted, `nothing reached stderr; captured: ${JSON.stringify(written)}`).toContain("interactive");
		// The refusal must still arm nothing.
		expect(await loop.store()).toBeNull();
	});

	it("a slash-command payload dispatches through the command path via expandPromptTemplates", async () => {
		const loop = await createLoopHarness();
		loop.harness.setResponses([]);
		await prompt(loop, "/loop 5m /loop status");

		// The tick payload itself is a /loop invocation: it must be consumed by the
		// command dispatcher, which renders the status listing as a second notice.
		await waitFor(
			() => loop.notices.filter((n) => n.message.includes("Active loops")).length >= 1,
			"nested status notice from dispatched tick",
		);
		const statusNotice = loop.notices.find((n) => n.message.includes("Active loops"))?.message ?? "";
		expect(statusNotice).toContain("Loop (fixed): next in");

		// Command-path consumption means no model turn and no raw tick text in the transcript.
		expect(getAssistantTexts(loop.harness)).toHaveLength(0);
		expect(getUserTexts(loop.harness).some((text) => text.includes("The fixed recurring schedule"))).toBe(false);
	});
});

function loopStatusFileExists(loop: LoopHarness): boolean {
	return existsSync(loopStateFilePath(loop.storeRef));
}
