// Probe for senpi#5410: spawns one owned sleeper, records its pid in the given file,
// then sends itself SIGTERM without calling stop() — the fixture's signal hooks must
// stop the sleeper and re-raise the signal so the process dies by SIGTERM.
import { writeFileSync } from "node:fs";
import { spawnOwnedSleeper } from "./shim-fixtures.ts";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("usage: sleeper-sigterm-probe.ts <pid-file>");
const sleeper = spawnOwnedSleeper();
writeFileSync(pidFile, String(sleeper.pid));
process.kill(process.pid, "SIGTERM");
