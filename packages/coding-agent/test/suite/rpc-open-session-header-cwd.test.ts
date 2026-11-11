/**
 * senpi#6427: an `open_session` that names a session file and no `cwd` works in the folder that file's header names,
 * as the session manager and the CLI open it, not in the folder the host was started in. An explicit `cwd` still
 * wins, an open that creates the session keeps the host's folder, and a header folder that is not on this host
 * refuses the open instead of falling back.
 *
 * Runs on the bare host's per-connection dispatch over a real socket with a real runtime
 * (`rpc-delegated-host-support.ts`): the host's own folder is never a folder a session here names, so nothing passes
 * because the two happen to be the same.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMovedLayout } from "./moved-path-guard-fixtures.ts";
import { type DelegatedHost, type Peer, startHost } from "./rpc-delegated-host-support.ts";

interface Opened {
	readonly sessionId: string;
	readonly state: { readonly cwd: string };
}

describe.each<[string, { readonly workers?: boolean }]>([
	["the in-process runtime", {}],
	["the worker runtime", { workers: true }],
])("open_session by path with no cwd, on %s (senpi#6427)", (_runtime, hostOptions) => {
	let host: DelegatedHost;
	let peer: Peer;
	let serial = 0;

	beforeAll(async () => {
		host = await startHost(hostOptions);
		peer = await host.proven();
	});
	afterAll(async () => {
		await host.dispose();
	});

	const folder = (name: string): string => {
		const dir = join(host.scratch, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	/** A session file with one message, whose header names `cwd`. */
	const sessionFile = (file: string, cwd: string): string => {
		const id = `0199f0d4-6427-7000-8000-${String(++serial).padStart(12, "0")}`;
		const lines = [
			{ type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-11-11T00:00:01.000Z",
				message: { role: "user", content: "remember 42", timestamp: 1 },
			},
		];
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		return file;
	};

	/** Where an opened session works, as each surface reports it, and the folders its file records a rules scan of. */
	const whereItWorks = async (opened: Opened, file: string) => {
		const state = (await peer.send({ type: "get_state", sessionId: opened.sessionId })).data as { cwd: string };
		const { sessions } = (await peer.send({ type: "list_sessions" })).data as {
			sessions: Array<{ sessionId: string; cwd: string }>;
		};
		const entries = readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as { customType?: string; data?: { cwd?: string } });
		return {
			answered: opened.state.cwd,
			state: state.cwd,
			listed: sessions.find((row) => row.sessionId === opened.sessionId)?.cwd,
			scanned: entries.filter((entry) => entry.customType === "pi-rules.scan").map((entry) => entry.data?.cwd),
		};
	};

	it("#given a session file whose header names folder A and a host started in folder B #when open_session names the file and no cwd #then the session works in A and nothing for B is appended to the file", async () => {
		const a = folder("project-a");
		const file = sessionFile(join(host.scratch, "sessions", "by-path.jsonl"), a);

		const opened = await peer.send({ type: "open_session", sessionPath: file });

		expect(opened).toMatchObject({ success: true });
		expect(host.cwd).not.toBe(a);
		expect(await whereItWorks(opened.data as Opened, file)).toEqual({
			answered: a,
			state: a,
			listed: a,
			scanned: [a],
		});
		expect(readFileSync(file, "utf8")).not.toContain(host.cwd);
	});

	it("#given the same kind of file #when open_session names a cwd too #then the named cwd wins", async () => {
		const named = folder("project-named");
		const file = sessionFile(join(host.scratch, "sessions", "named.jsonl"), folder("project-recorded"));

		const opened = await peer.send({ type: "open_session", sessionPath: file, cwd: named });

		expect(opened).toMatchObject({ success: true });
		expect(await whereItWorks(opened.data as Opened, file)).toMatchObject({
			answered: named,
			state: named,
			listed: named,
		});
	});

	it("#given a path no file is at yet #when open_session names it and no cwd #then the new session works in the host's folder", async () => {
		const file = join(host.scratch, "sessions", "created.jsonl");

		const opened = await peer.send({ type: "open_session", sessionPath: file });

		expect(opened).toMatchObject({ success: true, data: { state: { cwd: host.cwd } } });
	});

	it("#given a header folder that is not on this host #when open_session names the file and no cwd #then the open is refused and the session is not opened in the host's folder", async () => {
		const gone = join(host.scratch, "project-gone");
		const file = sessionFile(join(host.scratch, "sessions", "gone.jsonl"), gone);
		const bytes = readFileSync(file);

		const refused = await peer.send({ type: "open_session", sessionPath: file });

		expect(refused).toMatchObject({
			success: false,
			error: expect.stringContaining(`Stored session working directory does not exist: ${gone}`),
		});
		const { sessions } = (await peer.send({ type: "list_sessions" })).data as {
			sessions: Array<{ sessionPath?: string; status: string; cwd: string }>;
		};
		// The worker runtime lists a refused open as `closing` until its worker is gone; it is never an open session.
		const listed = sessions.filter((row) => row.sessionPath === file);
		expect(listed.filter((row) => row.status !== "closing" || row.cwd === host.cwd)).toEqual([]);
		expect(readFileSync(file)).toEqual(bytes);
	});

	it.each<[string, "newSessions" | "oldSessions"]>([
		["by the path the file is at", "newSessions"],
		["by the path the file had before the desktop moved it", "oldSessions"],
	])(
		"#given a header folder the desktop moved #when open_session names the file %s and no cwd #then the session works where the folder lives now",
		async (_how, spelling) => {
			const layout = createMovedLayout();
			try {
				const name = `moved-${spelling}.jsonl`;
				const file = sessionFile(join(layout.newSessions, name), layout.oldWorktree);

				const opened = await peer.send({ type: "open_session", sessionPath: join(layout[spelling], name) });

				expect(opened).toMatchObject({ success: true });
				expect(await whereItWorks(opened.data as Opened, file)).toMatchObject({
					answered: layout.newWorktree,
					state: layout.newWorktree,
					listed: layout.newWorktree,
				});
			} finally {
				layout.cleanup();
			}
		},
	);
});
