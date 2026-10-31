import type * as FsModule from "fs";
import { appendFileSync, readFileSync } from "fs";
import { dirname } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * senpi#4295: a session whose last save was torn (a full disk) tells the person once, on every surface that is
 * attached before they act, and a tear during a run is reported live, once.
 */

const fault = vi.hoisted(() => ({ appendKeepBytes: undefined as number | undefined }));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			const [path, data] = args;
			const keep = fault.appendKeepBytes;
			if (keep === undefined || typeof data !== "string") return actual.appendFileSync(...args);
			fault.appendKeepBytes = undefined;
			actual.appendFileSync(path, data.slice(0, keep));
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		},
	};
});

const harnesses: Harness[] = [];
afterEach(() => {
	fault.appendKeepBytes = undefined;
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

type Recovered = Extract<AgentSessionEvent, { type: "session_recovered" }>;

function recovered(events: readonly AgentSessionEvent[]): Recovered[] {
	return events.filter((event): event is Recovered => event.type === "session_recovered");
}

async function tornSession(): Promise<string> {
	const source = await createHarness({ persistSession: true, extensionFactories: [] });
	harnesses.push(source);
	source.setResponses([fauxAssistantMessage("first reply")]);
	await source.session.prompt("first");
	const file = source.sessionManager.getSessionFile();
	if (!file) throw new Error("test setup: persisted session has no file");
	appendFileSync(file, '{"type":"message","id":"torn","parentId":null,"message":{"role":"user","con');
	return file;
}

describe("senpi#4295 session_recovered notice", () => {
	it("is delivered once to each surface attached before the first prompt, and not after it", async () => {
		// Given a session reopened from a file whose last save was torn
		const file = await tornSession();
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [],
			sessionManager: SessionManager.open(file, dirname(file)),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("second reply")]);

		// When a second surface attaches, the person prompts, and a third surface attaches
		const second: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => second.push(event));
		await harness.session.prompt("second");
		const third: AgentSessionEvent[] = [];
		harness.session.subscribe((event) => third.push(event));

		// Then the first two surfaces saw the notice once and the third did not
		expect(recovered(harness.events).map(({ cause }) => cause)).toEqual(["unknown"]);
		expect(recovered(harness.events)[0]?.notice).toContain("wasn't saved completely");
		expect(recovered(second)).toHaveLength(1);
		expect(recovered(third)).toEqual([]);
	});

	it("reports a tear during a run live, once, with the disk-full cause", async () => {
		// Given a persisted session whose next transcript append runs out of space part-way
		const harness = await createHarness({ persistSession: true, extensionFactories: [] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("refused reply"),
			fauxAssistantMessage("third reply"),
		]);
		await harness.session.prompt("first");
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("test setup: persisted session has no file");
		fault.appendKeepBytes = 25;

		// When that turn fails and the next turn writes again
		await harness.session.prompt("second").catch(() => undefined);
		await harness.session.prompt("third");

		// Then one live notice named the full disk, and the file holds only complete lines
		expect(recovered(harness.events).map(({ cause }) => cause)).toEqual(["disk_full"]);
		expect(recovered(harness.events)[0]?.notice).toContain("because the disk was full");
		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
	});
});
