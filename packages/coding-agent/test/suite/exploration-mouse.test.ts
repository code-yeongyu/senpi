import { fauxAssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { explorationSurface } from "./exploration-surface-harness.ts";

it("expands original exploration calls through real mouse press and release dispatch", async () => {
	const surface = await explorationSurface();
	const terminal = new VirtualTerminal(120, 40);
	const ui = new TuiMainScreen(terminal);
	const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	vi.stubEnv("WT_SESSION", "exploration-mouse-test");
	try {
		const calls: ToolCall[] = [1, 201, 401].map((offset, index) => ({
			type: "toolCall",
			id: `mouse-read-${index}`,
			name: "read",
			arguments: { path: "src/sample.ts", offset, limit: 200 },
		}));
		const message = { ...fauxAssistantMessage(""), content: calls, stopReason: "toolUse" as const };
		await surface.event({ type: "message_start", message });
		for (const [index, call] of calls.entries()) {
			await surface.event({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: call, partial: message },
			});
		}
		await surface.event({ type: "message_end", message });
		for (const call of calls) {
			await surface.event({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: call.name,
				args: call.arguments,
			});
			await surface.event({
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: call.name,
				result: { content: [{ type: "text", text: `original-${call.id}` }] },
				isError: false,
			});
		}
		ui.addChild(surface.chat);
		ui.start();
		ui.acquireMouseCapture("always");
		ui.renderNow(true);
		expect(surface.text()).not.toContain("original-mouse-read");
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		ui.renderNow();
		for (const call of calls) expect(surface.text()).toContain(`original-${call.id}`);
		// Expanding grows the frame, which invalidates the mouse anchor on purpose (senpi#1651 fail-closed).
		// A real terminal recalibrates through CPR; this virtual one re-anchors on a cleared frame.
		ui.renderNow(true);
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		ui.renderNow();
		expect(surface.text()).not.toContain("original-mouse-read");
	} finally {
		ui.detachAll();
		ui.stop();
		surface.cleanup();
		if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		vi.unstubAllEnvs();
	}
});
