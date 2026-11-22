// A host armed from its environment the way the supervised host is (senpi#3816 round 7): reports when armed, and
// when its watchdog fires.
import { armHostWatchdog, readHostWatchdogConfig } from "../../src/modes/rpc/host-watchdog.ts";

// The watchdog never keeps a host alive (Node's lifetime reader is unref'd); the real host is held up by its server.
// Nothing else here is ref'd - Node unrefs the IPC channel of a child with no 'message' listener - so without this the
// child exits right after 'armed' and 'fired' can never arrive (senpi#5588).
process.channel?.ref();
armHostWatchdog(readHostWatchdogConfig(process.env), (reason) => {
	process.send?.({ type: "fired", reason }, () => process.exit(0));
});
process.send?.({ type: "armed" });
