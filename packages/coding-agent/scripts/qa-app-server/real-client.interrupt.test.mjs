import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const qaRoot = dirname(fileURLToPath(import.meta.url));

for (const file of ["real-client.mjs", "real-client-sweep.mjs"]) {
	test(`${file} subscribes to the interrupted background client's exit before observing the turn`, async () => {
		const source = await readFile(join(qaRoot, file), "utf8");
		const backgroundStart = source.indexOf("const background = spawnClient");
		const backgroundExit = source.indexOf("const backgroundExit = waitChild(background", backgroundStart);
		const turnStarted = source.indexOf("const started = await observer.waitForMessageEvent", backgroundStart);

		assert.notEqual(backgroundStart, -1, "missing interrupted background client");
		assert.notEqual(backgroundExit, -1, "missing background exit subscription");
		assert.notEqual(turnStarted, -1, "missing turn/started observer");
		assert.ok(backgroundStart < backgroundExit && backgroundExit < turnStarted, "background exit must be subscribed before the turn can complete");
	});
}
