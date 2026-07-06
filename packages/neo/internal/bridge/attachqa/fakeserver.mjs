/**
 * Sidecar for the task-17 attach-or-spawn QA harness.
 *
 * Starts the senpi-qa fake model server (deterministic, zero real API calls,
 * zero tokens) and a tiny control HTTP endpoint the Go harness polls to read the
 * recorded request log (so it can assert per-connection --api-key isolation on
 * the wire). Writes the fake server origin to the file given as argv[2] so the Go
 * harness can point models.json at it, then runs until SIGTERM.
 *
 * Usage: node fakeserver.mjs <origin-out-file> <control-port-out-file>
 */

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FAKE_SERVER = new URL(
	"../../../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs",
	import.meta.url,
).href;

async function main() {
	const originOut = process.argv[2];
	const controlOut = process.argv[3];
	if (!originOut || !controlOut) {
		process.stderr.write("usage: node fakeserver.mjs <origin-out> <control-port-out>\n");
		process.exit(2);
	}

	const mod = await import(FAKE_SERVER);
	const srv = await mod.startFakeModelServer({
		// Enough scripted turns for the two happy-path connections plus recovery.
		turns: [{ text: "OK" }, { text: "OK" }, { text: "OK" }, { text: "OK" }, { text: "OK" }, { text: "OK" }],
	});

	// Control endpoint: GET /requests returns the recorded request headers as JSON.
	const control = createServer((req, res) => {
		if (req.url === "/requests") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(srv.requests.map((r) => ({ authorization: r.authorization, apiKeyHeader: r.apiKeyHeader }))));
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});
	await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
	const controlPort = control.address().port;

	writeFileSync(originOut, srv.origin);
	writeFileSync(controlOut, String(controlPort));
	process.stdout.write(`FAKE-SERVER origin=${srv.origin} control=${controlPort}\n`);

	const shutdown = async () => {
		await srv.stop().catch(() => {});
		control.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		process.stderr.write(`fakeserver error: ${err?.stack || err}\n`);
		process.exit(1);
	});
}
