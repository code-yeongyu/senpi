/**
 * senpi#7020: a session reopened unattended arms a resume window of 8 automatic turns. The window counted every
 * engine start since the user's last message, including the ones that ran before the reopen, so a long lane (an
 * orchestrator that had run for hours on its own) was already over the cap the moment it reopened: an explicit
 * Resume released its hold and then started nothing. A Resume is a person's go-ahead, so it ends the window, as a
 * person's message does. The dormant reopen itself is unchanged: nothing runs until a person or a peer asks.
 */
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { engineTurnHistory } from "../../../src/core/engine-turn-limit.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
	appendHistoricalEngineStarts,
	cleanupParkHosts,
	parkedEntry,
	parkHost,
	parkScratch,
	reopenOnSuccessor,
	within,
} from "./7020-live-park-support.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
	await cleanupParkHosts();
});

const TURN_MS = 10_000;

// Gate 3: a session nobody was running when its host let it go stays dormant on the next host, but it is not deaf.
it("an idle-swept session reopens dormant, and the first peer delivery starts and runs its turn past 8 historical engine starts", async () => {
	const { dir, daemonDir, sessionPath } = await parkScratch();
	const host = await parkHost(dir, daemonDir);
	await host.open(sessionPath);
	// A session file is written once it holds an answer; the lane's own engine turns follow its last user message.
	await host.inScope(() => host.session.prompt("run the release train"));
	appendHistoricalEngineStarts(host.harness);
	await host.idleSweep();

	const successor = await reopenOnSuccessor(dir, daemonDir, await parkedEntry(daemonDir, sessionPath));
	expect(successor.session.sessionManager.reduceHistory(engineTurnHistory).starts.length).toBeGreaterThan(8);
	const callsAtReopen = successor.harness.faux.state.callCount;
	expect(callsAtReopen).toBe(0);
	expect(successor.session.paused).toBe(true);
	const answer = successor.inScope(() =>
		successor.session.externalAdmission.admit({
			delivery_id: "dormant-1",
			text: "[from lead] go on",
			deliverAs: "followUp",
		}),
	);
	expect(answer).toMatchObject({ kind: "started" });
	await within(successor.firstTurn, TURN_MS, "the peer delivery's turn");
	expect(successor.harness.faux.state.callCount).toBe(1);
	expect(successor.session.paused).toBe(false);
});

// Gate 5: the long lane reopened unattended, a wake arrived, and the person pressed Resume.
it("an explicit Resume on a long lane reopened unattended starts a turn past 8 historical engine starts", async () => {
	const h = await createHarness({
		persistSession: true,
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(h);
	h.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("done")])));
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	appendHistoricalEngineStarts(h);
	await h.session.sendCustomMessage(
		{ customType: "senpi-codemode:notification", content: "build finished", display: false },
		{ triggerTurn: true },
	);
	expect(h.session.paused).toBe(true);

	await h.session.resumeSession();
	await h.session.waitForIdle();
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.paused).toBe(false);
	expect(h.session.pausedNoticeCount).toBe(0);
	expect(
		h.session.messages.filter((m) => m.role === "custom" && m.customType === "senpi-codemode:notification"),
	).toHaveLength(1);
});
