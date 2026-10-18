import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { TTSR_LOOP_STOPPED_EVENT } from "../../../src/core/extensions/builtin/ttsr/follow-up-limit.ts";
import ttsrExtension from "../../../src/core/extensions/builtin/ttsr/index.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

// senpi#3014: the new second append must not hide the pre-existing TTSR stop event or notice.
it("announces the TTSR stop when its engine-paused publication throws", async () => {
	const stopped: unknown[] = [];
	let attempts = 0;
	harness = await createHarness({
		persistSession: true,
		extensionFactories: [
			(pi) => {
				pi.events.on(TTSR_LOOP_STOPPED_EVENT, (event) => stopped.push(event));
				const appendEntry = pi.appendEntry;
				ttsrExtension({
					...pi,
					appendEntry: (customType, data) => {
						if (customType === "engine-paused") {
							attempts += 1;
							throw new Error("Engine pause publication refused");
						}
						appendEntry(customType, data);
					},
				});
			},
		],
	});
	await harness.session.bindExtensions({ mode: "rpc" });
	const notices: Array<{ message: string; type: string | undefined }> = [];
	const runner = harness.getExtensionRunner();
	runner.setUIContext({ ...runner.getUIContext(), notify: (message, type) => notices.push({ message, type }) }, "rpc");
	harness.setResponses([
		fauxAssistantMessage(`analyzing ${"!".repeat(600)}`),
		fauxAssistantMessage(`again ${"!".repeat(600)}`),
	]);
	const session = harness.session;
	const idle = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error("Expected agent_idle"));
		}, 10_000);
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
	await session.prompt("work");
	await idle;

	expect(attempts).toBe(1);
	expect(
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "ttsr-loop-stopped"),
	).toHaveLength(1);
	expect(stopped).toEqual([{ rules: [expect.any(String)] }]);
	expect(notices).toEqual([{ message: expect.any(String), type: "warning" }]);
	const records: unknown[] = (await readFile(join(harness.tempDir, "agent", "logs", "session.log"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(records).toContainEqual(
		expect.objectContaining({
			level: "warn",
			event: "engine_turn_record_write_failed",
			kind: "engine-paused",
			error: expect.any(String),
		}),
	);
});
