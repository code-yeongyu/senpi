// A host armed from its environment the way the supervised host is (senpi#3816 round 7): reports when armed, and
// when its watchdog fires.
import { armHostWatchdog, readHostWatchdogConfig } from "../../src/modes/rpc/host-watchdog.ts";

armHostWatchdog(readHostWatchdogConfig(process.env), (reason) => {
	process.send?.({ type: "fired", reason }, () => process.exit(0));
});
process.send?.({ type: "armed" });
