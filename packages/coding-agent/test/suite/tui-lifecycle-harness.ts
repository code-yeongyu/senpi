import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { SessionLifecycle } from "../../src/core/session-lifecycle-types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

/** Interactive mode bound to a real session; the footer is rendered, not inspected through a status map. */
export function invoke(mode: InteractiveMode, name: string): unknown {
	const method: unknown = Reflect.get(mode, name);
	if (typeof method !== "function") throw new Error(`Missing ${name}`);
	return method.call(mode);
}

export function render(mode: InteractiveMode, width = 240): string {
	const footer: unknown = Reflect.get(mode, "footer");
	if (!footer || typeof footer !== "object" || !("render" in footer) || typeof footer.render !== "function")
		throw new Error("Missing rendered footer");
	const lines: string[] = footer.render(width);
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return stripVTControlCharacters(lines.join("\n"));
}

export function emit(session: AgentSession, lifecycle: SessionLifecycle): void {
	const publish: unknown = Reflect.get(session, "_emit");
	if (typeof publish !== "function") throw new Error("Missing session event path");
	publish.call(session, { type: "session_lifecycle", sessionId: session.sessionId, lifecycle });
}

export async function createTuiLifecycle(cleanups: Array<() => unknown>, h?: Harness) {
	const harness = h ?? (await createHarness());
	cleanups.push(() => harness.cleanup());
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime, { terminal: new VirtualTerminal(120, 40) });
	Reflect.set(mode, "isInitialized", true);
	cleanups.push(() => {
		Reflect.set(mode, "isInitialized", false);
		mode.stop({ restoreStderr: false });
	});
	invoke(mode, "subscribeToAgent");
	const base: SessionLifecycle = {
		...harness.session.lifecycle,
		seq: 100,
		state: "running",
		activity: undefined,
		activityRevision: { instanceId: harness.session.lifecycle.activityRevision?.instanceId ?? "owner", revision: 0 },
	};
	return { harness, runtime, mode, base };
}
