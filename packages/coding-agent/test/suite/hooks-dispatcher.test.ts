import { describe, expect, it } from "vitest";
import type { CommandHookRunResult } from "../../src/core/extensions/builtin/hooks/command-runner.ts";
import {
	dispatchHookEvent,
	type HookCommandRunner,
	runningHookHandlersStatusLabel,
} from "../../src/core/extensions/builtin/hooks/dispatcher.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type {
	ExecutableHookHandler,
	HookInputWire,
	HookSourceMetadata,
	HookTrustEntry,
	HookTrustState,
} from "../../src/core/extensions/builtin/hooks/types.ts";

const SOURCE: HookSourceMetadata = {
	discoveredAt: "pre-session",
	displayOrder: 7,
	scope: "project",
	sourcePath: "/repo/.senpi/hooks.json",
};

const INPUT: HookInputWire = {
	cwd: "/repo",
	event: "PreToolUse",
	toolInput: { command: "rm -rf build" },
	toolName: "bash",
};

type DeferredRun = {
	readonly promise: Promise<CommandHookRunResult>;
	readonly resolve: (result: CommandHookRunResult) => void;
};

function commandHook(
	command: string,
	overrides: {
		readonly event?: ExecutableHookHandler["event"];
		readonly matcher?: string;
		readonly groupIndex?: number;
		readonly handlerIndex?: number;
		readonly source?: HookSourceMetadata;
	} = {},
): ExecutableHookHandler {
	const base = {
		config: { type: "command", command },
		event: overrides.event ?? "PreToolUse",
		groupIndex: overrides.groupIndex ?? 0,
		handlerIndex: overrides.handlerIndex ?? 0,
		source: overrides.source ?? SOURCE,
	} satisfies Omit<ExecutableHookHandler, "matcher">;
	if (overrides.matcher === undefined) {
		return base;
	}
	return { ...base, matcher: overrides.matcher };
}

function trustedState(handlers: readonly ExecutableHookHandler[]): HookTrustState {
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of handlers) {
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: "linux",
			updatedAt: "2026-06-29T00:00:00.000Z",
		});
	}
	return { hooks, version: 1 };
}

function runResult(handler: ExecutableHookHandler, stdout: string, stderr = ""): CommandHookRunResult {
	const streamSafety = (text: string) => ({
		originalBytes: Buffer.byteLength(text),
		redacted: false,
		returnedBytes: Buffer.byteLength(text),
		spilled: false,
		truncated: false,
	});
	return {
		aborted: false,
		command: handler.config.command,
		cwd: "/repo",
		durationMs: 1,
		exitCode: 0,
		outputSafety: { stderr: streamSafety(stderr), stdout: streamSafety(stdout) },
		signal: null,
		stderr,
		stdout,
		timedOut: false,
		timeoutSeconds: 30,
	};
}

function preToolOutput(
	permissionDecision: "allow" | "ask" | "deny",
	fields: Readonly<Record<string, unknown>> = {},
): string {
	return JSON.stringify({
		hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...fields },
	});
}

function dispatch(
	handlers: readonly ExecutableHookHandler[],
	runCommand: HookCommandRunner,
	options: {
		readonly input?: HookInputWire;
		readonly trusted?: readonly ExecutableHookHandler[];
		readonly onRunningHandlersChange?: (running: readonly ExecutableHookHandler[]) => void;
	} = {},
) {
	return dispatchHookEvent({
		cwd: "/repo",
		handlers,
		input: options.input ?? INPUT,
		...(options.onRunningHandlersChange === undefined
			? {}
			: { onRunningHandlersChange: options.onRunningHandlersChange }),
		runCommand,
		trustOptions: { platform: "linux" },
		trustState: trustedState(options.trusted ?? handlers),
	});
}

function deferredRun(): DeferredRun {
	let resolveRun: ((result: CommandHookRunResult) => void) | undefined;
	const promise = new Promise<CommandHookRunResult>((resolve) => {
		resolveRun = resolve;
	});
	if (resolveRun === undefined) {
		throw new Error("deferred run resolver was not initialized");
	}
	return { promise, resolve: resolveRun };
}

describe("builtin hooks dispatcher", () => {
	it("starts all matching trusted hooks before aggregating and keeps summaries in declaration order", async () => {
		// Given
		const allowSlow = commandHook("allow-slow", { handlerIndex: 0, matcher: "Bash" });
		const denyFast = commandHook("deny-fast", { handlerIndex: 1, matcher: "bash" });
		const miss = commandHook("miss", { handlerIndex: 2, matcher: "Read" });
		const deferred = new Map<string, DeferredRun>();
		const startedCommands: string[] = [];
		const runner: HookCommandRunner = (handler) => {
			startedCommands.push(handler.config.command);
			const pending = deferredRun();
			deferred.set(handler.config.command, pending);
			return pending.promise;
		};

		// When
		const dispatching = dispatch([allowSlow, denyFast, miss], runner);
		await Promise.resolve();

		// Then
		expect(startedCommands).toEqual(["allow-slow", "deny-fast"]);

		deferred
			.get("deny-fast")
			?.resolve(runResult(denyFast, preToolOutput("deny", { permissionDecisionReason: "dangerous command" })));
		deferred
			.get("allow-slow")
			?.resolve(runResult(allowSlow, preToolOutput("allow", { updatedInput: { command: "printf safe" } })));
		const result = await dispatching;

		expect(result.summaries.map((summary) => summary.handler.config.command)).toEqual(["allow-slow", "deny-fast"]);
		expect(result.summaries.map((summary) => summary.completionIndex)).toEqual([1, 0]);
		expect(result.decision).toEqual({
			kind: "block",
			reason: "dangerous command",
			source: denyFast.source,
			sourceCommand: "deny-fast",
		});
		expect(result.diagnostics).toEqual([]);
	});

	it("aggregates PreToolUse ask above allow and returns explicit blocking fallback data", async () => {
		// Given
		const allow = commandHook("allow", { handlerIndex: 0 });
		const ask = commandHook("ask", { handlerIndex: 1 });
		const runner: HookCommandRunner = (handler) => {
			if (handler.config.command === "ask") {
				return Promise.resolve(
					runResult(handler, preToolOutput("ask", { permissionDecisionReason: "needs human approval" })),
				);
			}
			return Promise.resolve(
				runResult(handler, preToolOutput("allow", { updatedInput: { command: "printf safe" } })),
			);
		};

		// When
		const result = await dispatch([allow, ask], runner);

		// Then
		expect(result.decision.kind).toBe("ask");
		expect(result.decision).toEqual({
			fallback: { kind: "block", reason: "needs human approval" },
			kind: "ask",
			nativeRepresentable: false,
			reason: "needs human approval",
			source: ask.source,
			sourceCommand: "ask",
		});
	});

	it("returns updated input when PreToolUse has only allow decisions", async () => {
		// Given
		const first = commandHook("first", { handlerIndex: 0 });
		const second = commandHook("second", { handlerIndex: 1 });
		const runner: HookCommandRunner = (handler) =>
			Promise.resolve(
				runResult(
					handler,
					preToolOutput("allow", { updatedInput: { command: `${handler.config.command}-input` } }),
				),
			);

		// When
		const result = await dispatch([first, second], runner);

		// Then
		expect(result.decision).toEqual({
			kind: "allow",
			source: second.source,
			sourceCommand: "second",
			updatedInput: { command: "second-input" },
		});
	});

	it("skips matched untrusted hooks while listing them", async () => {
		// Given
		const trusted = commandHook("trusted", { handlerIndex: 0 });
		const untrusted = commandHook("untrusted", { handlerIndex: 1 });
		const startedCommands: string[] = [];
		const runner: HookCommandRunner = (handler) => {
			startedCommands.push(handler.config.command);
			return Promise.resolve(runResult(handler, ""));
		};

		// When
		const result = await dispatch([trusted, untrusted], runner, { trusted: [trusted] });

		// Then
		expect(startedCommands).toEqual(["trusted"]);
		expect(result.skipped.map((skip) => ({ command: skip.handler.config.command, reason: skip.reason }))).toEqual([
			{ command: "untrusted", reason: "untrusted" },
		]);
		expect(result.skipped[0]?.record.executable).toBe(false);
	});

	it("notifies onRunningHandlersChange as hooks start and finish", async () => {
		// Given
		const first = commandHook("run-first", { handlerIndex: 0, matcher: "bash" });
		const second = commandHook("run-second", { handlerIndex: 1, matcher: "bash" });
		const deferred = new Map<string, DeferredRun>();
		const runner: HookCommandRunner = (handler) => {
			const pending = deferredRun();
			deferred.set(handler.config.command, pending);
			return pending.promise;
		};
		const transitions: string[][] = [];

		// When
		const dispatching = dispatch([first, second], runner, {
			onRunningHandlersChange: (running) => transitions.push(running.map((handler) => handler.config.command)),
		});
		await Promise.resolve();
		deferred.get("run-first")?.resolve(runResult(first, ""));
		await Promise.resolve();
		await Promise.resolve();
		deferred.get("run-second")?.resolve(runResult(second, ""));
		await dispatching;

		// Then
		expect(transitions).toEqual([["run-first"], ["run-first", "run-second"], ["run-second"], []]);
	});

	it("builds running-hook status labels from statusMessage with command fallback", () => {
		// Given
		const labeled: ExecutableHookHandler = {
			...commandHook("node run-hook.mjs comment-checker", { matcher: "bash" }),
			config: {
				type: "command",
				command: "node run-hook.mjs comment-checker",
				statusMessage: "(OmO) Checking Comments",
			},
		};
		const bare = commandHook("sleep 5 # lsp-diagnostics-pass", { handlerIndex: 1, matcher: "bash" });
		const windowsAware: ExecutableHookHandler = {
			...commandHook("posix.sh", { handlerIndex: 2 }),
			config: { type: "command", command: "posix.sh", commandWindows: "windows.cmd" },
		};
		const noisy: ExecutableHookHandler = {
			...commandHook("noisy", { handlerIndex: 3 }),
			config: { type: "command", command: "noisy", statusMessage: `line\u001b[31mone\ntwo\t ${"y".repeat(200)}` },
		};

		// When / Then
		expect(runningHookHandlersStatusLabel([labeled], "linux")).toBe("(OmO) Checking Comments");
		expect(runningHookHandlersStatusLabel([bare], "linux")).toBe("sleep 5 # lsp-diagnostics-pass");
		expect(runningHookHandlersStatusLabel([labeled, bare], "linux")).toBe(
			"(OmO) Checking Comments · sleep 5 # lsp-diagnostics-pass",
		);
		expect(runningHookHandlersStatusLabel([windowsAware], "win32")).toBe("windows.cmd");
		expect(runningHookHandlersStatusLabel([windowsAware], "linux")).toBe("posix.sh");
		const noisyLabel = runningHookHandlersStatusLabel([noisy], "linux");
		expect(noisyLabel.startsWith("lineone two y")).toBe(true);
		expect(noisyLabel.length).toBeLessThanOrEqual(79);
	});

	it("keeps nonblocking malformed output diagnostics nonfatal but blocks on explicit continue false", async () => {
		// Given
		const malformed = commandHook("malformed", { event: "PostToolUse", handlerIndex: 0 });
		const stop = commandHook("stop", { event: "Stop", handlerIndex: 0 });
		const runner: HookCommandRunner = (handler) => {
			if (handler.event === "Stop") {
				return Promise.resolve(runResult(handler, JSON.stringify({ continue: false, stopReason: "not done" })));
			}
			return Promise.resolve(runResult(handler, "{not json"));
		};

		// When
		const postTool = await dispatch([malformed], runner, {
			input: {
				cwd: "/repo",
				event: "PostToolUse",
				toolInput: {},
				toolName: "bash",
				toolOutput: "ok",
			},
			trusted: [malformed, stop],
		});
		const stopResult = await dispatch([stop], runner, {
			input: { cwd: "/repo", event: "Stop", stopReason: "natural" },
			trusted: [malformed, stop],
		});

		// Then
		expect(postTool.decision).toEqual({ kind: "none" });
		expect(postTool.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_root", path: "stdout" }));
		expect(stopResult.decision).toEqual({
			kind: "block",
			reason: "not done",
			source: stop.source,
			sourceCommand: "stop",
		});
	});
});
