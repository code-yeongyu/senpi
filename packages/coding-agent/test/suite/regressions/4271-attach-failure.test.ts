/**
 * senpi#4271 review: when an attach fails after the session is attached, the failure is what the user
 * sees, even if the release sent on the way out fails too.
 */
import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AttachedTui } from "../../../src/modes/interactive/attach.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

type Sent = { readonly type: string };

function attachedWith(answer: (command: Sent) => unknown) {
	initTheme("dark");
	const view = new AttachedTui(new TUI(new VirtualTerminal(80, 24)), () => {});
	const sent: string[] = [];
	const client = {
		connect: async () => {},
		close: () => {},
		request: async (command: Sent) => {
			sent.push(command.type);
			return answer(command);
		},
	};
	Object.defineProperty(view, "client", { value: client });
	return { view, sent };
}

describe("attach failure reporting (senpi#4271)", () => {
	it("throws the attach failure, not the release failure, when both fail", async () => {
		const { view, sent } = attachedWith((command) => {
			switch (command.type) {
				case "list_sessions":
					return {
						command: "list_sessions",
						data: { sessions: [{ sessionId: "s1", durableSessionId: "d1", retain_on_disconnect: true }] },
					};
				case "subscribe_sessions":
					return { command: "subscribe_sessions", data: { snapshot: [] } };
				case "get_state":
					throw new Error("state unavailable");
				case "release_attachment":
					throw new Error("release refused");
				default:
					return { command: command.type };
			}
		});
		const failure = await view.connect("unused", "s1").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("state unavailable");
		expect(sent).toContain("release_attachment");
	});

	it("throws the attach failure itself when the release succeeds", async () => {
		const { view } = attachedWith((command) => {
			if (command.type === "list_sessions")
				return {
					command: "list_sessions",
					data: { sessions: [{ sessionId: "s1", durableSessionId: "d1", retain_on_disconnect: true }] },
				};
			if (command.type === "subscribe_sessions") return { command: "subscribe_sessions", data: { snapshot: [] } };
			if (command.type === "get_state") throw new Error("state unavailable");
			return { command: command.type };
		});
		await expect(view.connect("unused", "s1")).rejects.toThrow(/^state unavailable$/);
	});
});
