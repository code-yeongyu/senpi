import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { builtInMessageRenderer } from "../src/modes/interactive/components/remote-delivery-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const HEADER = "[OMO_GATEWAY v=1 source=peer_agent actor=planner sender_session=01a1 delivery=d-1]";

beforeAll(() => initTheme("dark"));

function delivered(details: Record<string, unknown>): string[] {
	const message: CustomMessage = {
		role: "custom",
		customType: SESSION_CONTROL_DELIVERY_TYPE,
		content: `${HEADER}\nA message from another session.\n"review the diff"`,
		display: true,
		details: { delivery_id: "d-1", source: "session_control", deliverAs: "followUp", ...details },
		timestamp: 0,
	};
	const component = new CustomMessageComponent(
		message,
		builtInMessageRenderer(SESSION_CONTROL_DELIVERY_TYPE),
		undefined,
		1,
	);
	return component
		.render(100)
		.map(stripAnsi)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

describe("a delivered message in the terminal", () => {
	it("labels another session's message with its name and shows the text as written, not the provenance header", () => {
		const lines = delivered({
			sender: { kind: "agent", session_id: "01a1", name: "planner" },
			display_text: "review the diff",
		});
		expect(lines).toEqual(["Sent by another agent · planner", "review the diff"]);
	});

	it("labels an unnamed session's message without a name", () => {
		const lines = delivered({ sender: { kind: "agent", session_id: "01a1" }, display_text: "review the diff" });
		expect(lines[0]).toBe("Sent by another agent");
	});

	it("labels a command-line send", () => {
		const lines = delivered({ sender: { kind: "command_line", user: "tester" }, display_text: "from the shell" });
		expect(lines).toEqual(["Sent from the command line", "from the shell"]);
	});

	it("labels an external chat with its platform, and its author when it has one", () => {
		expect(
			delivered({ sender: { kind: "external", platform: "slack", author: "Jane" }, display_text: "ship it" }),
		).toEqual(["Sent from slack · Jane", "ship it"]);
		expect(delivered({ sender: { kind: "external", platform: "slack" }, display_text: "ship it" })[0]).toBe(
			"Sent from slack",
		);
		expect(
			delivered({ sender: { kind: "external", platform: "slack", author: "  " }, display_text: "ship it" })[0],
		).toBe("Sent from slack");
	});

	it("falls back to the generic heading, never a wrong label, for a sender it cannot read", () => {
		for (const sender of [
			{ kind: "agent" },
			{ kind: "agent", session_id: 7 },
			{ kind: "external" },
			{ kind: "automation", session_id: "01a1" },
			"agent",
			null,
		]) {
			const lines = delivered({ sender, display_text: "review the diff" });
			expect(lines[0]).toBe("remote message · delivery d-1");
			expect(lines.join("\n")).toContain("OMO_GATEWAY v=1");
		}
	});

	it("falls back to the generic heading when a sender is named but the written text is not", () => {
		const lines = delivered({ sender: { kind: "agent", session_id: "01a1", name: "planner" } });
		expect(lines[0]).toBe("remote message · delivery d-1");
		expect(lines.join("\n")).toContain("OMO_GATEWAY v=1");
	});

	it("keeps the generic heading and the full text for a delivery from a sender that names no sender", () => {
		const lines = delivered({});
		expect(lines[0]).toBe("remote message · delivery d-1");
		expect(lines.join("\n")).toContain("OMO_GATEWAY v=1");
	});
});
