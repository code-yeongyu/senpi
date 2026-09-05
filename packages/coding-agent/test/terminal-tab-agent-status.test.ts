import { formatTerminalTitleSequence } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { APP_NAME, APP_TITLE } from "../src/config.ts";
import {
	formatAgentActivityProcessTitle,
	formatAgentActivityTitle,
} from "../src/modes/interactive/agent-activity-status.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ActivityStatusThis = {
	activeToolExecutionTerminalTitle: string | undefined;
	activeToolTerminalTitle: string | undefined;
	agentActivityStatus: "working" | "idle";
	extensionTerminalTitle: string | undefined;
	applyProcessActivityTitle(): void;
	applyTerminalTitle(): void;
	getNormalTerminalTitle(): string;
	setAgentActivityStatus(status: "working" | "idle"): void;
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
	};
	ui: {
		terminal: {
			setTitle(title: string): void;
		};
	};
};

type ActivityStatusPrototype = {
	applyProcessActivityTitle(this: ActivityStatusThis): void;
	applyTerminalTitle(this: ActivityStatusThis): void;
	getNormalTerminalTitle(this: ActivityStatusThis): string;
	setAgentActivityStatus(this: ActivityStatusThis, status: "working" | "idle"): void;
};

function createActivityStatusThis(setTitle: (title: string) => void): ActivityStatusThis {
	const prototype = InteractiveMode.prototype as unknown as ActivityStatusPrototype;
	const fakeThis: ActivityStatusThis = {
		activeToolExecutionTerminalTitle: undefined,
		activeToolTerminalTitle: undefined,
		agentActivityStatus: "idle",
		extensionTerminalTitle: undefined,
		applyProcessActivityTitle: prototype.applyProcessActivityTitle,
		applyTerminalTitle: prototype.applyTerminalTitle,
		getNormalTerminalTitle: prototype.getNormalTerminalTitle,
		setAgentActivityStatus: prototype.setAgentActivityStatus,
		sessionManager: {
			getCwd: () => "/tmp/senpi-project",
			getSessionName: () => "Visible Session",
		},
		ui: {
			terminal: { setTitle },
		},
	};
	return fakeThis;
}

describe("terminal tab agent status", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("OSC title sequence includes OSC 2, the sequence Zed documents for terminal titles", () => {
		// Given / When
		const sequence = formatTerminalTitleSequence("senpi - project");

		// Then
		expect(sequence).toContain("\x1b]2;senpi - project\x07");
		// OSC 0 is kept so terminals that only track the icon name still update.
		expect(sequence).toContain("\x1b]0;senpi - project\x07");
	});

	test("terminal title carries a leading working token while the agent runs", () => {
		// Given
		const setTitle = vi.fn();
		const fakeThis = createActivityStatusThis(setTitle);

		// When
		fakeThis.setAgentActivityStatus("working");

		// Then
		expect(setTitle).toHaveBeenLastCalledWith(`[working] ${APP_TITLE} - Visible Session - senpi-project`);

		// When
		fakeThis.setAgentActivityStatus("idle");

		// Then: idle is the resting state and keeps the plain title
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - Visible Session - senpi-project`);
	});

	test("an unset activity status renders the plain title, never a stray token", () => {
		// Given a caller that never initialized the status field
		const setTitle = vi.fn();
		const fakeThis = createActivityStatusThis(setTitle);
		(fakeThis as { agentActivityStatus?: "working" | "idle" }).agentActivityStatus = undefined;

		// When
		fakeThis.applyTerminalTitle();

		// Then
		expect(setTitle).toHaveBeenLastCalledWith(`${APP_TITLE} - Visible Session - senpi-project`);
	});

	test("status token stays in front of active tool titles so it survives tab truncation", () => {
		// Given
		const setTitle = vi.fn();
		const fakeThis = createActivityStatusThis(setTitle);
		fakeThis.activeToolExecutionTerminalTitle = `${APP_TITLE} - Running bash: npm run check`;

		// When
		fakeThis.setAgentActivityStatus("working");

		// Then
		const title = setTitle.mock.calls.at(-1)?.[0] as string;
		expect(title.startsWith("[working] ")).toBe(true);
		expect(title).toContain("Running bash: npm run check");
	});

	test("mirrors the status into process.title for terminals that label tabs from the process", () => {
		// Given
		const originalProcessTitle = process.title;
		const setTitle = vi.fn();
		const fakeThis = createActivityStatusThis(setTitle);

		try {
			// When
			fakeThis.setAgentActivityStatus("working");

			// Then
			expect(process.title).toBe(`${APP_NAME} [working]`);

			// When
			fakeThis.setAgentActivityStatus("idle");

			// Then
			expect(process.title).toBe(`${APP_NAME} [idle]`);
		} finally {
			process.title = originalProcessTitle;
		}
	});

	test("repeated identical status updates do not rewrite the title", () => {
		// Given
		const setTitle = vi.fn();
		const fakeThis = createActivityStatusThis(setTitle);
		const originalProcessTitle = process.title;

		try {
			// When
			fakeThis.setAgentActivityStatus("working");
			fakeThis.setAgentActivityStatus("working");

			// Then
			expect(setTitle).toHaveBeenCalledTimes(1);
		} finally {
			process.title = originalProcessTitle;
		}
	});

	test("formats status tokens for empty titles without stray separators", () => {
		expect(formatAgentActivityTitle("working", "")).toBe("[working]");
		expect(formatAgentActivityTitle("idle", "")).toBe("");
		expect(formatAgentActivityProcessTitle("idle", "senpi")).toBe("senpi [idle]");
		expect(formatAgentActivityProcessTitle("working", "senpi")).toBe("senpi [working]");
	});
});
