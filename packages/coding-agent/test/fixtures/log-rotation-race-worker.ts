// One of several OS processes that log through the same agent dir at once. A file barrier releases them together so
// they cross the rotation cap at the same moment (senpi#2976). Prints {"written","dropped"} as its last stdout line.
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createConfigReloadLogger } from "../../src/core/extensions/builtin/config-reload/log.ts";

const [agentDir, barrier, tag, linesArg, maxBytesArg] = process.argv.slice(2);
const lines = Number(linesArg);
const maxBytes = Number(maxBytesArg);

while (!existsSync(barrier)) await sleep(1);

const logger = createConfigReloadLogger(agentDir, { maxBytes });
let written = 0;
let dropped = 0;
for (let index = 0; index < lines; index++) {
	const status = logger.info("reload_requested", {
		reason: `${tag}-${index}-${"x".repeat(150)}`,
		paths: [`/tmp/${tag}/settings.json`],
	});
	if (status.written) written += 1;
	else dropped += 1;
}
console.log(JSON.stringify({ written, dropped }));
