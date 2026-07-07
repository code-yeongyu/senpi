/**
 * Detached fake-model-server host for `mock-env.mjs`.
 *
 * `startFakeModelServer` is in-process, so the mock-env parent cannot host it and
 * exit (a plain `eval $(...)` would kill the server). This child runs the server
 * in a process that OUTLIVES the parent: it prints its bound port on stdout as a
 * single `READY {json}` line, then stays alive (the listening socket keeps the
 * event loop running) until `kill $ULW_MOCK_PID`. An interval mirrors each new
 * request's last user-text line into the request log for QA assertions.
 *
 * Contract (all via env, set by the parent):
 *   MOCK_ENV_TURNS  JSON array of scripted turns for startFakeModelServer
 *   MOCK_ENV_LOG    absolute path of the requests log to append to
 */

import { appendFileSync } from "node:fs";
import { startFakeModelServer } from "../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs";

function lastUserText(messages) {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
		}
		return "";
	}
	return "";
}

async function main() {
	const turns = JSON.parse(process.env.MOCK_ENV_TURNS || "[{}]");
	const logPath = process.env.MOCK_ENV_LOG;

	const server = await startFakeModelServer({ turns });
	process.stdout.write(`READY ${JSON.stringify({ port: server.port, origin: server.origin, url: server.url })}\n`);

	let logged = 0;
	setInterval(() => {
		for (; logged < server.requests.length; logged++) {
			try {
				appendFileSync(logPath, `${lastUserText(server.requests[logged].messages)}\n`);
			} catch {}
		}
	}, 100);
}

main().catch((error) => {
	process.stderr.write(`mock-env-child: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
