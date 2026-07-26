import { TerminalSession } from "@earendil-works/pi-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import registerTerminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import { createBashInputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-input.ts";
import { createBashOutputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import { createBashResizeTool } from "../../src/core/extensions/builtin/terminal/tools/bash-resize.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import type { Harness } from "./harness.ts";
import { createHarness } from "./harness.ts";

const COMPANIONS = ["bash_output", "bash_input", "bash_resize", "kill_bash", "monitor"];

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("terminal builtin extension — tool surface & mutual exclusion", () => {
	const harnesses: Harness[] = [];
	const savedAnthropicBash = process.env.PI_ANTHROPIC_BASH;

	afterEach(() => {
		if (savedAnthropicBash === undefined) delete process.env.PI_ANTHROPIC_BASH;
		else process.env.PI_ANTHROPIC_BASH = savedAnthropicBash;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function anthropicHarness(): Promise<Harness> {
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			models: [
				{ id: "claude-test", reasoning: false },
				{ id: "claude-test-2", reasoning: false },
			],
			extensionFactories: [registerTerminalExtension],
		});
		harnesses.push(harness);
		return harness;
	}

	it("registers PTY bash plus the four companion tools", async () => {
		delete process.env.PI_ANTHROPIC_BASH;
		const harness = await anthropicHarness();
		await harness.session.bindExtensions({});
		const active = harness.session.getActiveToolNames();
		expect(active).toContain("bash");
		for (const companion of COMPANIONS) expect(active).toContain(companion);
	});

	it("steps aside — companions absent — when native Anthropic bash is active", async () => {
		process.env.PI_ANTHROPIC_BASH = "1";
		const harness = await anthropicHarness();
		await harness.session.bindExtensions({});
		const active = harness.session.getActiveToolNames();
		for (const companion of COMPANIONS) expect(active).not.toContain(companion);
	});

	it("re-activates companions when native Anthropic bash is disabled on model switch", async () => {
		process.env.PI_ANTHROPIC_BASH = "1";
		const harness = await anthropicHarness();
		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).not.toContain("bash_output");

		delete process.env.PI_ANTHROPIC_BASH;
		await harness.session.setModel(harness.getModel("claude-test-2")!);
		const active = harness.session.getActiveToolNames();
		for (const companion of COMPANIONS) expect(active).toContain(companion);
	});
});

describe("terminal builtin extension — real session execution (pipe fallback)", () => {
	let manager: TerminalManager;
	let ctx: TerminalToolContext;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager({});
		ctx = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => process.env,
		};
	});

	afterEach(async () => {
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("runs a foreground command and returns its output", async () => {
		const bash = createPtyBashTool(ctx);
		const result = await bash.execute("call-fg", { command: "echo hello-fg" }, undefined);
		expect(firstText(result)).toContain("hello-fg");
	});

	it("returns a bash_id promptly for background commands and peeks new output", async () => {
		const bash = createPtyBashTool(ctx);
		const output = createBashOutputTool(ctx);
		const started = await bash.execute(
			"call-bg",
			{ command: "sleep 0.3; echo READY_MARK", run_in_background: true },
			undefined,
		);
		const idMatch = /ID: (bash_\d+)/.exec(firstText(started));
		expect(idMatch).not.toBeNull();
		const bashId = idMatch![1]!;

		// Wait for the output event-driven (monitor-style), then peek without blocking.
		const runtime = ctx.manager.get(bashId);
		if (!runtime) throw new Error(`No terminal session found with id: ${bashId}`);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("READY_MARK never arrived within 5s")), 5000);
			const unsubscribe = runtime.onOutput((chunk) => {
				if (!chunk.includes("READY_MARK")) return;
				clearTimeout(timer);
				unsubscribe();
				resolve();
			});
		});
		const peeked = await output.execute("call-peek", { bash_id: bashId });
		expect(firstText(peeked)).toContain("READY_MARK");
	});

	it("kills a background session and reports absence afterward", async () => {
		const bash = createPtyBashTool(ctx);
		const kill = createKillBashTool(ctx);
		const output = createBashOutputTool(ctx);
		const started = await bash.execute("call-bg2", { command: "sleep 30", run_in_background: true }, undefined);
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))![1]!;

		const killed = await kill.execute("call-kill", { bash_id: bashId });
		expect(firstText(killed)).toContain(`Killed ${bashId}`);

		// After teardown-on-stop the entry is swept; a follow-up read reports it gone.
		await manager.stop(bashId);
		const readBack = await output.execute("call-read", { bash_id: bashId });
		expect(firstText(readBack)).toMatch(/status: |No terminal session/);
	});

	it("rejects input to a missing session and reports pipe-fallback resize", async () => {
		const input = createBashInputTool(ctx);
		const resize = createBashResizeTool(ctx);
		const missing = await input.execute("call-missing", { bash_id: "bash_999", input: "x" });
		expect(missing.isError).toBe(true);

		const bash = createPtyBashTool(ctx);
		const started = await bash.execute("call-bg3", { command: "sleep 5", run_in_background: true }, undefined);
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))![1]!;
		const resized = await resize.execute("call-resize", { bash_id: bashId, cols: 100, rows: 30 });
		// Pipe fallback cannot resize a real PTY, so it returns an informative note, not a hard error.
		expect(firstText(resized).toLowerCase()).toContain("resize");
	});
});

describe("terminal runtime session startup ordering", () => {
	it("subscribes to output before starting a fast session", () => {
		const calls: string[] = [];
		const start = vi.spyOn(TerminalSession.prototype, "start").mockImplementation(function (this: TerminalSession) {
			calls.push("start");
			return this;
		});
		const onData = vi.spyOn(TerminalSession.prototype, "onData").mockImplementation(() => {
			calls.push("onData");
			return () => {};
		});
		const onExit = vi.spyOn(TerminalSession.prototype, "onExit").mockReturnValue(() => {});

		const runtime = new TerminalRuntimeSession("fast-exit", { command: "true" });
		try {
			expect(calls).toEqual(["onData", "start"]);
		} finally {
			runtime.dispose();
			start.mockRestore();
			onData.mockRestore();
			onExit.mockRestore();
		}
	});
});

describe("terminal permission gating", () => {
	it("classifies bash_input in the bash permission class via its input field", () => {
		const registry = createBuiltinParserRegistry();
		const requests = registry.parse("bash_input", { input: "rm -rf /tmp/thing" }, "/tmp");
		expect(requests[0]?.permission).toBe("bash");
		expect(requests[0]?.patterns).toContain("rm");
	});
});

describe("terminal builtin extension — bash_output robustness", () => {
	let manager: TerminalManager;
	let ctx: TerminalToolContext;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager({});
		ctx = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => process.env,
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("bash_output peek returns immediately for a silent long-running session", async () => {
		const bash = createPtyBashTool(ctx);
		const output = createBashOutputTool(ctx);
		const started = await bash.execute("call-bg-abort", { command: "sleep 30", run_in_background: true }, undefined);
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Background bash did not return an id");

		const peekPromise = output.execute("call-peek-immediate", { bash_id: bashId });
		const peekCompleted = new Promise<Awaited<typeof peekPromise>>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("peek did not return within 1 second")), 1000);
			peekPromise.then(
				(value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timeout);
					reject(error);
				},
			);
		});

		const result = await peekCompleted;
		expect(firstText(result)).toContain("status: running");

		const statusCheck = await output.execute("call-status-check", { bash_id: bashId });
		expect(firstText(statusCheck)).toContain("status: running");
		await manager.stop(bashId);
	});

	it("wait_for ghost param returns migration guidance naming monitor without blocking", async () => {
		const bash = createPtyBashTool(ctx);
		const output = createBashOutputTool(ctx);
		const started = await bash.execute("call-bg-ghost", { command: "sleep 30", run_in_background: true }, undefined);
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Background bash did not return an id");

		const ghostPromise = output.execute("call-ghost-wait", {
			bash_id: bashId,
			wait_for: "NEVER_MATCHES_THIS_PATTERN_XYZ",
			timeout: 10,
		});
		const ghostCompleted = new Promise<Awaited<typeof ghostPromise>>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("ghost-param call blocked for over 1 second")), 1000);
			ghostPromise.then(
				(value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timeout);
					reject(error);
				},
			);
		});

		const result = await ghostCompleted;
		expect(result.isError).toBe(true);
		const text = firstText(result);
		expect(text).toContain("wait_for removed");
		expect(text).toContain("monitor(");
		expect(text).toContain("kill_bash");

		// The session is untouched: peek still works and kill tears it down.
		const statusCheck = await output.execute("call-status-after-ghost", { bash_id: bashId });
		expect(firstText(statusCheck)).toContain("status: running");
		await manager.stop(bashId);
	});
});
