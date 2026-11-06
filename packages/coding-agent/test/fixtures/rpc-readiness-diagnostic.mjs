import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// The marker means stderr exists, not that the fixture answers get_protocol_info.
writeSync(2, "fixture readiness diagnostic\n");
writeFileSync(join(process.argv[2], "stderr-ready"), "");
setInterval(() => {}, 1000);
