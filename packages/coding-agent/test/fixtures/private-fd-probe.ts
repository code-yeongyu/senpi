import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { preparePrivateFdSpawn } from "../../src/private-fd-spawn.ts";
import {
	privateChannelDeclared,
	privateFdTableUnparseable,
	privateTablePresent,
	takeInheritedPrivateChannel,
} from "../../src/private-fds.ts";

// Imports only the capture and the forwarding helper, so it runs unchanged under Node and Bun.
const mode = process.argv[2];

if (mode === "report") {
	const stream = takeInheritedPrivateChannel("sample-channel");
	stream?.destroy();
	writeSync(
		1,
		JSON.stringify({
			available: stream !== undefined,
			declared: privateChannelDeclared("sample-channel"),
			present: privateTablePresent(),
			unparseable: privateFdTableUnparseable(),
		}),
	);
	if (process.connected) process.disconnect?.();
} else if (mode === "leak-probe") {
	// A tool child started with ignored stdio must hold no private descriptor, adopted or not.
	const listed = spawnSync("/bin/sh", ["-c", "for f in 5 24 64; do [ -e /dev/fd/$f ] && printf '%s ' $f; done"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const high = takeInheritedPrivateChannel("high");
	const top = takeInheritedPrivateChannel("top");
	writeSync(
		1,
		JSON.stringify({
			open: listed.stdout.toString().trim(),
			high: { declared: privateChannelDeclared("high"), available: high !== undefined },
			top: { declared: privateChannelDeclared("top"), available: top !== undefined },
		}),
	);
	takeInheritedPrivateChannel("sample-channel")?.destroy();
} else if (mode === "double-spawn") {
	// An ensure retry spawns twice: the second hop still receives every declared name.
	const tables = [0, 1].map(() => {
		const transfer = preparePrivateFdSpawn({ env: {}, stdio: "ignore" });
		transfer.close();
		return transfer.options.env.SENPI_PRIVATE_FDS ?? null;
	});
	writeSync(1, JSON.stringify(tables));
}
