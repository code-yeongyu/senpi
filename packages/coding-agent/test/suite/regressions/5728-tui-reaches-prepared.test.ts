// senpi#5728 (S36, plan amendment A4): the TUI (InteractiveMode, main.ts) runs the user's prompt on the session the
// production runtime built, and that prompt's tool call runs on the prepared pipeline with no batch-store argument.
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { createAgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { type Cleanups, preparedCall, productionFactory, watch } from "./5728-entry-fixture.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	vi.unstubAllEnvs();
});

it("InteractiveMode's initial prompt runs its tool call on the prepared pipeline", async () => {
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
	const { dir, createRuntime } = await productionFactory(cleanups);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: dir,
		agentDir: dir,
		sessionManager: SessionManager.inMemory(dir),
	});
	await runtime.session.bindExtensions({});
	cleanups.push(() => runtime.dispose());
	const { witnesses, witnessed } = watch(runtime);
	const mode = new InteractiveMode(runtime, { initialMessage: "go" });
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	Reflect.set(mode, "isInitialized", true);
	cleanups.push(() => ui.stop());
	void mode.run();
	await witnessed;
	expect(witnesses).toEqual(preparedCall);
});
