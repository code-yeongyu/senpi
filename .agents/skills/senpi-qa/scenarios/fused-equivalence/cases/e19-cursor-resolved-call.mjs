// E19 (plan §6.4, X7): Cursor resolved call. O1-O7.
//
// The session runs on a `cursor-agent` provider served by the local plaintext-HTTP/2 fake Cursor backend the senpi-qa
// Cursor exec QA already uses (scripts/scenarios/cursor-exec-lifecycle: the real generated protobuf schemas). The
// backend sends an exec readArgs frame; today's cursor exec bridge resolves it by running the session's `read` tool
// and answers readResult then one streamClose; the backend then ends the turn. O1-O4 come from the Run stream (the
// decoded client frames and the request headers) instead of the fake model server. Every client frame is decoded in
// full with the generated schema (the shared wire log keeps only a 240-character prefix): the runRequest is what senpi
// sends to Cursor, so its whole message is O1. Its content-addressed blob ids hash the prompt (sandbox path, date), so
// the normalizer maps them one-to-one by key like every other id. The client's run-level heartbeat frames are
// keep-alives on a timer, not behavior, so they are left out of O1.
import { randomUUID } from "node:crypto";
import { fromBinary, toJson } from "@bufbuild/protobuf";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	QA_MODEL,
	QA_PROVIDER,
	seedCursorProvider,
} from "../../../scripts/scenarios/cursor-exec-lifecycle/cli-turn.mjs";
import { startRunServer } from "../../../scripts/scenarios/cursor-exec-lifecycle/run-server.mjs";
import { playReadLifecycle } from "../../../scripts/scenarios/cursor-exec-lifecycle/scenarios.mjs";
import { loadCursorWire, RUN_PATH } from "../../../scripts/scenarios/cursor-exec-lifecycle/wire.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const TIMER_FRAMES = new Set(["clientHeartbeat"]);

export default {
	id: "E19",
	title: "Cursor resolved call (X7)",
	observables: WITHOUT_O8,
	spec: { turns: [{ text: "E19-UNUSED" }], files: { "cursor-target.txt": "E19-CURSOR-READ\nsecond line\n" } },
	async drive(run) {
		const wire = await loadCursorWire();
		const decodedWire = {
			...wire,
			summarizeClient: (bytes) => {
				const { detail, ...summary } = wire.summarizeClient(bytes);
				const schema = wire.schemas.AgentClientMessageSchema;
				return { ...summary, decoded: toJson(schema, fromBinary(schema, bytes)) };
			},
		};
		const token = `qa-cursor-${randomUUID()}`;
		const cursor = await startRunServer(decodedWire, { expectedAuthorization: `Bearer ${token}` });
		run.cleanups.push(() => cursor.close());
		const origin = `http://127.0.0.1:${cursor.port}`;
		run.extraRoots.push({ prefix: origin, token: "<cursor-server>" }, { prefix: token, token: "<cursor-token>" });
		seedCursorProvider(run.box, { baseUrl: origin, token });
		writeFileSync(join(run.box.agentDir, "settings.json"), "{}\n");
		run.args = run.args.map((arg, index, all) =>
			all[index - 1] === "--provider" ? QA_PROVIDER : all[index - 1] === "--model" ? QA_MODEL : arg,
		);
		run.providerRequests = () => [
			{
				method: "POST",
				url: RUN_PATH,
				headers: cursor.headersReceipt ?? {},
				body: {
					frames: cursor.log.entries.filter((e) => !TIMER_FRAMES.has(e.case)).map(({ tMs, i, ...frame }) => frame),
				},
			},
		];
		await run.open();
		const play = playReadLifecycle(cursor, wire, {
			id: 101,
			path: join(run.box.cwd, "cursor-target.txt"),
			toolCallId: "call-cursor-read",
			finalText: "E19-CURSOR-DONE",
		}).catch((error) => error);
		await run.prompt("read the cursor target");
		const outcome = await play;
		if (outcome instanceof Error) throw outcome;
		await run.close();
	},
};
