/**
 * senpi#6312: a supervisor process that may have adopted an engine trust generation spawns its host child
 * through the production `spawnHostChild`; the child reports how it classifies the trust it arrived with.
 * `supervisor [marker]` records the marker as adopted first, the way omo's trust stage does.
 */
import { writeSync } from "node:fs";
import {
	classifyTrustArrival,
	parseEngineTrustMarker,
	recordAdoptedEngineTrust,
} from "../../src/engine-trust/index.ts";
import { loadHostChildTrustHandOff, spawnHostChild } from "../../src/modes/rpc/host-lifecycle-launch.ts";

const [mode, markerText] = process.argv.slice(2);

if (mode === "child") {
	writeSync(2, `${JSON.stringify(classifyTrustArrival(process.env, process.platform))}\n`);
	process.exit(0);
} else if (mode === "supervisor") {
	if (markerText !== undefined) {
		const marker = parseEngineTrustMarker(markerText);
		if (marker === undefined) process.exit(4);
		recordAdoptedEngineTrust(marker);
	}
	const child = spawnHostChild({
		launch: {
			socket: "fixture",
			hostArgs: [],
			childCommand: process.execPath,
			childArgs: [import.meta.filename, "child"],
		},
		internalSocket: "fixture",
		internal: { secretPath: "unused" },
		daemonDir: "unused",
		instanceId: "fixture",
		cleanupPaths: [],
		publicSocket: "fixture",
		trustHandOff: await loadHostChildTrustHandOff(),
	});
	child.once("error", () => process.exit(3));
	child.once("exit", (code) => process.exit(code ?? 3));
}
