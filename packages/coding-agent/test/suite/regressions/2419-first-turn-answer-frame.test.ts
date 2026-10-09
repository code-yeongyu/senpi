/**
 * senpi#2419: an ask-user answer frame (`[Answer to question <id>]\n...`) is a reply to a question
 * asked on an earlier turn, never the session's first request. When every earlier turn was an
 * extension or custom message (an onboarding bootstrap, a control-endpoint delivery), the answer
 * was the branch's first user message, so the first-turn opener armed on it: the model got the
 * hidden reminder and, under `force`, a named `todo` tool_choice instead of acting on the answer.
 */

import { rmSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	FIRST_TURN_CUSTOM_TYPE,
	type FirstTurnGateInput,
	shouldArmFirstTurn,
} from "../../../src/core/extensions/builtin/todotools/first-turn.ts";
import todotoolsExtension from "../../../src/core/extensions/builtin/todotools/index.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { fauxTodotoolsPi, TODO_PAYLOAD } from "../todo-first-turn-harness.ts";

const ANSWER = "[Answer to question q-1]\nShip: yes";

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userEntry(
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
): SessionEntry {
	return {
		type: "message",
		id: "u-1",
		parentId: null,
		timestamp: "2026-09-30T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	};
}

const ARMED: FirstTurnGateInput = {
	preview: false,
	trigger: "prompt",
	prompt: "add retries to fetchUser",
	branchEntries: [],
	todoActive: true,
	setting: "force",
	mode: "tui",
};

describe("shouldArmFirstTurn with ask-user answer frames (senpi#2419)", () => {
	it.each<[string, Partial<FirstTurnGateInput>, boolean]>([
		["skips an answer frame", { prompt: ANSWER }, false],
		["skips a CRLF answer frame", { prompt: "[Answer to question q-1]\r\nShip: yes" }, false],
		[
			"arms for a work request after an earlier answer frame",
			{ branchEntries: [userEntry([{ type: "text", text: ANSWER }])] },
			true,
		],
		[
			"skips a work request after a real user request",
			{ branchEntries: [userEntry([{ type: "text", text: "fix it" }])] },
			false,
		],
		[
			"skips a work request after a text-less (image-only) user message",
			{ branchEntries: [userEntry([{ type: "image", data: "AAAA", mimeType: "image/png" }])] },
			false,
		],
	])("%s", (_label, override, expected) => {
		// given
		const input = { ...ARMED, ...override };

		// when
		const armed = shouldArmFirstTurn(input);

		// then
		expect(armed).toBe(expected);
	});
});

describe("first-turn tool_choice on an answer frame (senpi#2419)", () => {
	it("injects no reminder and forces no todo tool_choice when the answer is the first user message", async () => {
		// given: todotools on its default `force` setting, with no user message on the branch
		const faux = fauxTodotoolsPi(tempDirs);

		// when
		const start = await faux.startTurn(ANSWER);
		const payload = await faux.providerRequest(TODO_PAYLOAD);

		// then
		expect(start.message).toBeUndefined();
		expect(payload).toBeUndefined();
	});
});

function firstTurnEntries(harness: Harness): SessionEntry[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === FIRST_TURN_CUSTOM_TYPE);
}

describe("first-turn reminder on an answer frame through the real AgentSession (senpi#2419)", () => {
	it("does not arm on the answer after an extension-triggered turn, and arms on the next work request", async () => {
		// given: an extension starts the session's first turn, so no user message is on the branch
		const harness = await createHarness({ extensionFactories: [todotoolsExtension] });
		harnesses.push(harness);
		harness.getExtensionRunner().setUIContext(undefined, "tui");
		harness.setResponses([
			fauxAssistantMessage("which release?"),
			fauxAssistantMessage("shipping"),
			fauxAssistantMessage("on it"),
		]);
		await harness.session.sendCustomMessage(
			{ customType: "test:bootstrap", content: "Greet the user.", display: false },
			{ triggerTurn: true },
		);

		// when: the user's answer to the pending question arrives as the first user message
		await harness.session.prompt(ANSWER);

		// then
		expect(firstTurnEntries(harness)).toHaveLength(0);

		// when: the user then sends a real work request
		await harness.session.prompt("add retries to fetchUser");

		// then
		expect(firstTurnEntries(harness)).toHaveLength(1);
	}, 20_000);
});
