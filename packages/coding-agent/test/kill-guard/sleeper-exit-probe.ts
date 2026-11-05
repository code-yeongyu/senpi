// Probe for senpi#5410: spawns one owned sleeper, records its pid in the given file,
// then exits WITHOUT calling stop() — the fixture's exit hooks must kill the sleeper.
import { writeFileSync } from "node:fs";
import { spawnOwnedSleeper } from "./shim-fixtures.ts";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: sleeper-exit-probe.ts <pid-file>");
const sleeper = spawnOwnedSleeper();
writeFileSync(pidFile, String(sleeper.pid));
