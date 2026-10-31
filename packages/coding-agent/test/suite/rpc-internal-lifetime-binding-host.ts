// The host end of the binding test: bootstraps stdin like the real host, arms the lifetime binding through the one
// interface, and exits when the supervisor is gone.

import { armLifetimeBinding, HOST_WATCH_LIFETIME_FIFO_ENV } from "../../src/modes/rpc/host-lifetime-binding.ts";
import { getInternalHostBootstrap } from "../../src/modes/rpc/internal-bootstrap.ts";

const bootstrap = getInternalHostBootstrap();
const stop = armLifetimeBinding(
	{ lifetimeFifo: process.env[HOST_WATCH_LIFETIME_FIFO_ENV], lifetimeFd: bootstrap?.lifetimeFd },
	() => process.exit(0),
	() => process.exit(3),
);
process.stdout.write(`${stop === undefined ? "unarmed" : "armed"}\n`);
// Stays alive only for its binding: no IPC to the supervisor that could end it some other way.
setInterval(() => {}, 2 ** 30);
