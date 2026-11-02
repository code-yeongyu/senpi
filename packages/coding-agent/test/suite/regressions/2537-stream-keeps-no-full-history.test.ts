import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

function compactedSession(): SessionManager {
	const dir = makeTempDir(join(tmpdir(), "s2537-stream-"));
	const session = SessionManager.create(dir, dir);
	session.appendMessage(userMsg("watch the build"));
	session.appendMessage(assistantMsg("watching"));
	const firstKept = session.appendMessage(userMsg("and report each event"));
	session.appendMessage(assistantMsg("will do"));
	session.appendCompaction("summary of the watch so far", firstKept, 100);
	session.dropMaterializedCaches();
	return session;
}

describe("senpi#2537 a sustained event stream does not hold a compacted session's whole history", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("starts every engine-triggered turn without a full-history view resident", async () => {
		const sessionManager = compactedSession();
		harness = await createHarness({ sessionManager });
		harness.setResponses([
			fauxAssistantMessage("event 1 noted"),
			fauxAssistantMessage("event 2 noted"),
			fauxAssistantMessage("event 3 noted"),
		]);
		const heldAtTurnStart: boolean[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "turn_start") heldAtTurnStart.push(sessionManager.holdsMaterializedHistory());
		});

		for (let event = 1; event <= 3; event++) {
			await harness.session.sendCustomMessage(
				{ customType: "bench-monitor", content: `[monitor] event ${event}`, display: false },
				{ triggerTurn: true },
			);
			await harness.session.waitForIdle();
		}

		expect(heldAtTurnStart).toEqual([false, false, false]);
	});
});
