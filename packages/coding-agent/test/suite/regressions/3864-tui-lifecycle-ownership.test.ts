import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import type { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { LIFECYCLE_STATUS_KEY } from "../../../src/modes/interactive/lifecycle-status.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createTuiLifecycle, emit, invoke, render } from "../tui-lifecycle-harness.ts";

const cleanups: Array<() => unknown> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function lifecycleStatus(mode: InteractiveMode): string | undefined {
	const provider = Reflect.get(mode, "footerDataProvider") as { getExtensionStatuses(): ReadonlyMap<string, string> };
	return provider.getExtensionStatuses().get(LIFECYCLE_STATUS_KEY);
}

it("keeps the lifecycle footer status through /reload and keeps following later lifecycle changes", async () => {
	const { harness, mode, base } = await createTuiLifecycle(cleanups);
	const state = harness.session.lifecycle.state;
	expect(lifecycleStatus(mode)).toBe(state);
	expect(render(mode)).toContain(state);
	const showError = vi.spyOn(mode as unknown as { showError(message: string): void }, "showError");
	await invoke(mode, "handleReloadCommand");
	expect(showError).not.toHaveBeenCalled();
	expect(lifecycleStatus(mode)).toBe(state);
	expect(render(mode)).toContain(state);
	emit(harness.session, { ...base, state: "waiting_background" });
	expect(lifecycleStatus(mode)).toBe("waiting_background");
	expect(render(mode)).toContain("waiting_background");
});

it("an extension UI reset clears extension statuses but keeps the host-owned lifecycle status", async () => {
	const { harness, mode } = await createTuiLifecycle(cleanups);
	const ui = invoke(mode, "createExtensionUIContext") as ExtensionUIContext;
	ui.setStatus("my-ext", "mine");
	expect(render(mode)).toContain("mine");
	invoke(mode, "resetExtensionUI");
	expect(render(mode)).not.toContain("mine");
	expect(lifecycleStatus(mode)).toBe(harness.session.lifecycle.state);
});

it("reserves the lifecycle status key: extensions cannot overwrite or clear it", async () => {
	const { harness, mode } = await createTuiLifecycle(cleanups);
	const ui = invoke(mode, "createExtensionUIContext") as ExtensionUIContext;
	const before = render(mode);
	expect(before).toContain(harness.session.lifecycle.state);
	ui.setStatus(LIFECYCLE_STATUS_KEY, "hijacked");
	expect(render(mode)).toBe(before);
	ui.setStatus(LIFECYCLE_STATUS_KEY, undefined);
	expect(render(mode)).toBe(before);
	ui.setStatus("my-ext", "mine");
	expect(render(mode)).toContain("mine");
	expect(render(mode)).toContain(harness.session.lifecycle.state);
});

it("clears the lifecycle status on stop() without requesting a frame after the footer is disposed", async () => {
	const { mode } = await createTuiLifecycle(cleanups);
	const order: string[] = [];
	const footer = Reflect.get(mode, "footer") as { dispose(): void };
	const dispose = footer.dispose.bind(footer);
	vi.spyOn(footer, "dispose").mockImplementation(() => {
		order.push("dispose");
		dispose();
	});
	// `ui` is a proxy over the active renderer; spy on the renderer that actually schedules frames.
	const tui = Reflect.get(mode, "renderer") as { requestRender(force?: boolean): void };
	vi.spyOn(tui, "requestRender").mockImplementation(() => order.push("render"));
	Reflect.set(mode, "isInitialized", false);
	mode.stop({ restoreStderr: false });
	expect(order.slice(order.indexOf("dispose"))).toEqual(["dispose"]);
	const provider = Reflect.get(mode, "footerDataProvider") as { getExtensionStatuses(): ReadonlyMap<string, string> };
	expect(provider.getExtensionStatuses().has(LIFECYCLE_STATUS_KEY)).toBe(false);
});
