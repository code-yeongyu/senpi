// Child process for test/session-store/bun-default.test.ts (bun:sqlite needs Bun): `bun <file> <json args>` prints
// JSON result lines; "hold" actions wait for one stdin line before writing.
import { openSyncSessionStore, type SessionHeader } from "@earendil-works/pi-agent-core";
import { openDefaultSessionStore, takeOverSessionStore } from "../../src/core/session-store/default-store.ts";

interface Args {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly action: "append" | "hold-then-append" | "takeover-then-append" | "crash-at-claim" | "read";
	readonly count?: number;
	readonly tag?: string;
}

const args = JSON.parse(process.argv[2] ?? "{}") as Args;
// Every writer here belongs to one project; scoping by project is covered through createAgentSession.
const sessionDir = "/project";
const header: SessionHeader = {
	type: "session",
	version: 3,
	id: args.sessionId,
	timestamp: "2026-11-05T00:00:00.000Z",
	cwd: "/",
};
const say = (value: object): void => console.log(JSON.stringify(value));

async function released(): Promise<void> {
	for await (const _chunk of process.stdin) return;
}

if (args.action === "crash-at-claim") {
	await openDefaultSessionStore({
		agentDir: args.agentDir,
		sessionDir,
		sessionId: args.sessionId,
		onWritePoint: (point) => {
			if (point.op === "claim" && point.at === "before") process.exit(70);
		},
	});
	say({ crashed: false });
} else {
	let bound = await openDefaultSessionStore({ agentDir: args.agentDir, sessionDir, sessionId: args.sessionId });
	if (args.action === "takeover-then-append") bound = await takeOverSessionStore(bound);
	const handle = await openSyncSessionStore(bound.store, bound.epoch).open(args.sessionId, header);
	if (args.action === "read") {
		say({ keys: handle.entries().map((entry) => entry.key) });
	} else {
		if (args.action === "hold-then-append") {
			say({ ready: true, epoch: bound.epoch });
			await released();
		}
		const tag = args.tag ?? "w";
		try {
			for (let index = 0; index < (args.count ?? 1); index++) {
				const key = `${tag}-${index}`;
				handle.appendSync([
					{ key, line: JSON.stringify({ type: "custom", id: key, customType: "probe", data: { tag, index } }) },
				]);
			}
			say({ ok: true, epoch: bound.epoch });
		} catch (error) {
			say({
				ok: false,
				epoch: bound.epoch,
				code: error instanceof Error && "code" in error ? String(error.code) : "unknown",
			});
		}
	}
}
