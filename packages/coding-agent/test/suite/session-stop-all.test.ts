import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import stopExtension from "../../src/core/extensions/builtin/stop/index.ts";
import registerTerminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import { whenRestoreDecided } from "../../src/core/extensions/builtin/terminal/restore-session.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionFactory, SessionStopReport } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

// oh-my-openagent#14390: one stop ends everything the session owns, and a restart brings none of it back.

/** Stands in for an extension that owns child work (omo's task component): it answers the stop with what it ended. */
function childOwner(stopped: string[]): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.on("session_stop", () => {
			stopped.push("child-1");
			return { stopped: [{ kind: "child", id: "child-1", label: "fix the login flow" }], failed: [] };
		});
	};
}

function extensions(stopped: string[]) {
	return [
		{ factory: registerTerminalExtension, path: "<builtin:terminal>" },
		{ factory: goalExtension, path: "<builtin:goal>" },
		{ factory: stopExtension, path: "<builtin:stop>" },
		{ factory: childOwner(stopped), path: "<test:child-owner>" },
	];
}

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) {
		await harness.session.executeTool("kill_bash", { all: true }).catch(() => undefined);
		harness.cleanup();
	}
});

async function open(stopped: string[], sibling?: Harness): Promise<Harness> {
	const file = sibling?.sessionManager.getSessionFile();
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: extensions(stopped),
		...(sibling === undefined || file === undefined
			? {}
			: { siblingOf: sibling, sessionManager: SessionManager.open(file), cwd: sibling.tempDir }),
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await whenRestoreDecided(harness.sessionManager.getSessionId());
	return harness;
}

/** Arm all four kinds of work a session owns: an active goal, a persistent monitor, a background shell, a child. */
async function armEverything(harness: Harness): Promise<void> {
	await createGoal(goalStoreRef(harness.sessionManager, harness.tempDir), "Ship the release, then stop");
	const monitor = await harness.session.executeTool("monitor", {
		description: "release watch",
		command: "while true; do echo tick; sleep 30; done",
		persistent: true,
	});
	expect(monitor.isError).toBeFalsy();
	const shell = await harness.session.executeTool("bash", {
		command: "sleep 300",
		run_in_background: true,
		description: "long build",
	});
	expect(shell.isError).toBeFalsy();
}

/** The model obeys "then stop" inside a turn: it calls `stop_session` by name, and the report comes back as the result. */
async function modelStops(harness: Harness): Promise<SessionStopReport> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("stop_session", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("Stopped."),
	]);
	await harness.session.prompt("Ship the release, then stop.");
	const end = harness.eventsOfType("tool_execution_end").findLast((event) => event.toolName === "stop_session");
	expect(end?.isError).toBe(false);
	return end?.result.details as SessionStopReport;
}

async function restart(stopped: string[], harness: Harness): Promise<Harness> {
	await emitSessionShutdownEvent(harness.getExtensionRunner(), { type: "session_shutdown", reason: "quit" });
	harness.session.dispose();
	return open(stopped, harness);
}

/** What the reopened session still holds: the goal on disk and every terminal session it restored. */
async function heldAfterReopen(harness: Harness) {
	const goal = await readGoal(goalStoreRef(harness.sessionManager, harness.tempDir));
	const killed = await harness.session.executeTool("kill_bash", { all: true });
	const text = killed.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	return { goalStatus: goal?.status ?? null, restoredSessions: Number(/Killed (\d+)/.exec(text)?.[1] ?? "-1") };
}

describe("session stop (oh-my-openagent#14390)", () => {
	it("control: without a stop, a restart revives the goal and restores the persistent monitor", async () => {
		const stopped: string[] = [];
		const first = await open(stopped);
		await armEverything(first);
		const second = await restart(stopped, first);
		const held = await heldAfterReopen(second);
		expect(held.goalStatus).toBe("active");
		expect(held.restoredSessions).toBeGreaterThan(0);
	});

	it("stop_session ends the goal, every monitor and shell, and each owner's children; a restart brings none back", async () => {
		const stopped: string[] = [];
		const first = await open(stopped);
		await armEverything(first);

		const report = await modelStops(first);
		const kinds = (path: string) =>
			report.owners.find((owner) => owner.extensionPath === path)?.stopped.map((item) => item.kind) ?? [];
		expect(kinds("<builtin:goal>")).toEqual(["goal"]);
		expect(kinds("<builtin:terminal>").sort()).toEqual(["background_shell", "monitor"]);
		expect(kinds("<test:child-owner>")).toEqual(["child"]);
		expect(report.owners.flatMap((owner) => owner.failed)).toEqual([]);
		expect(stopped).toEqual(["child-1"]);

		const second = await restart(stopped, first);
		expect(await heldAfterReopen(second)).toEqual({ goalStatus: null, restoredSessions: 0 });
	});

	it("is idempotent: a second stop with nothing armed reports nothing and fails nothing", async () => {
		const first = await open([]);
		await modelStops(first);
		const report = await modelStops(first);
		expect(
			report.owners
				.filter((owner) => owner.extensionPath !== "<test:child-owner>")
				.flatMap((owner) => owner.stopped),
		).toEqual([]);
		expect(report.owners.flatMap((owner) => owner.failed)).toEqual([]);
	});
});
