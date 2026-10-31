import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import { heldHarness } from "./3853-review-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});
const monitor = { customType: "senpi-monitor:event", content: "monitor event", display: false };

// senpi#3853 review D/E: thirteen steers during ONE tool turn are not thirteen engine turns.
it("keeps thirteen attended monitor steers in their tool turn without pausing", async () => {
	const { h, entered, release } = await heldHarness({
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	harnesses.push(h);
	const running = h.session.prompt("use a tool");
	await entered.promise;
	try {
		for (let i = 0; i < 13; i++) await h.session.sendCustomMessage(monitor, { triggerTurn: true });
		expect(h.session.messages.some((m) => m.role === "custom" && m.customType === monitor.customType)).toBe(false);
	} finally {
		release.resolve();
		await running;
	}
	expect(
		h.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "engine-turn-start"),
	).toHaveLength(0);
	expect(
		h.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "engine-paused"),
	).toHaveLength(0);
	const before = h.faux.state.callCount;
	await h.session.sendCustomMessage({ ...monitor, customType: "goal-continuation" }, { triggerTurn: true });
	expect(h.faux.state.callCount - before).toBe(1);
});

// Review M10: an attended reopen does not opt into the unattended resume window.
it("does not apply the unattended cap to loaded history on an attended resume", async () => {
	const { h, release } = await heldHarness({
		sessionStartEvent: { type: "session_start", reason: "resume" },
	});
	harnesses.push(h);
	release.resolve();
	h.setResponses([fauxAssistantMessage([fauxText("continued")])]);
	for (let i = 0; i < 8; i++) h.sessionManager.appendCustomEntry("engine-turn-start", { customType: "monitor" });
	await h.session.sendCustomMessage(monitor, { triggerTurn: true });
	expect(h.faux.state.callCount).toBe(1);
});
