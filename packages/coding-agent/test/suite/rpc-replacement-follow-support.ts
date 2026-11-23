/**
 * Replaces the session behind a hosted handle IN THE SAME FOLDER with each of the four commands that can do it, on the
 * real release host, and reads what the host's record of that handle holds right after the replacement's answer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import type { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";
import type { startReleaseHost } from "./rpc-release-host-support.ts";

type Host = Awaited<ReturnType<typeof startReleaseHost>>;
type Wire = Record<string, unknown>;

export const REPLACING_COMMANDS = ["new_session", "switch_session", "fork", "clone"] as const;
export type ReplacingCommand = (typeof REPLACING_COMMANDS)[number];

const command = (value: Wire): RpcCommand & { id: string } => value as unknown as RpcCommand & { id: string };
const data = (answer: Wire): Wire => (answer.data ?? {}) as Wire;

function context(host: Host): RouterContext {
	return Reflect.get(host.router, "context") as RouterContext;
}

/** The host's stored record of the handle: what release, unload and a park claim read. */
export function storedRecord(host: Host, handle: string) {
	const entry = context(host).registry.peek(handle);
	return { sessionPath: entry?.sessionPath, durableSessionId: entry?.durableSessionId };
}

/** Writes the stored record of the handle, to show a reader takes its values from somewhere else. */
export function overwriteStoredRecord(host: Host, handle: string, sessionPath: string, durableSessionId: string): void {
	const entry = context(host).registry.peek(handle);
	if (entry === undefined) throw new Error(`no entry for ${handle}`);
	entry.sessionPath = sessionPath;
	entry.durableSessionId = durableSessionId;
}

/**
 * A replacement answers before the new session's extensions are bound; until they are, a release or an unload is
 * refused as busy. Waits on the session's own signal for that work to end.
 */
export async function bindingSettled(host: Host, handle: string): Promise<void> {
	const session = context(host).registry.peek(handle)?.runtime?.session;
	if (session === undefined) throw new Error(`no session behind ${handle}`);
	await (Reflect.get(session, "_waitForSettledSessionWork") as () => Promise<void>).call(session);
}

/**
 * Opens S1 behind a handle and replaces it with S2 in S1's folder. `stored` is the host's record right after the
 * replacement's answer; `old` and `next` are what `get_state` names before and after.
 */
export async function replaceInSameFolder(host: Host, replacing: ReplacingCommand) {
	const s1 = await host.open("s1");
	const handle = s1.sessionId;
	const before = data(await host.send(command({ type: "get_state", id: "state-before", sessionId: handle })));
	let replaced: Wire;
	if (replacing === "switch_session") {
		const other = await host.open("s2");
		// Freed, so the switch takes a file no other handle holds (a close from a connection that never opened it is refused).
		const freed = await host.send(command({ type: "unload_session", id: "free-s2", sessionId: other.sessionId }));
		if ((freed.data as Wire | undefined)?.outcome !== "unloaded")
			throw new Error(`unload failed: ${JSON.stringify(freed)}`);
		replaced = await host.send(
			command({ type: "switch_session", id: "replace", sessionId: handle, sessionPath: other.sessionPath }),
		);
	} else if (replacing === "fork") {
		const forkable = data(await host.send(command({ type: "get_fork_messages", id: "forkable", sessionId: handle })))
			.messages as Array<{ entryId: string }>;
		replaced = await host.send(
			command({ type: "fork", id: "replace", sessionId: handle, entryId: forkable[0]?.entryId, position: "at" }),
		);
	} else {
		replaced = await host.send(command({ type: replacing, id: "replace", sessionId: handle }));
	}
	if (replaced.success !== true) throw new Error(`${replacing} failed: ${JSON.stringify(replaced)}`);
	const stored = storedRecord(host, handle);
	const after = data(await host.send(command({ type: "get_state", id: "state-after", sessionId: handle })));
	const old = { sessionFile: String(before.sessionFile), sessionId: String(before.sessionId) };
	const next = { sessionFile: String(after.sessionFile), sessionId: String(after.sessionId) };
	if (old.sessionId === next.sessionId || dirname(next.sessionFile) !== dirname(old.sessionFile))
		throw new Error(`${replacing} did not replace the session in the same folder`);
	return { handle, stored, old, next };
}

/** The transcripts in `folder` that hold a `session_released` entry. */
export function sealedTranscripts(folder: string): string[] {
	return readdirSync(folder)
		.filter((name) => name.endsWith(".jsonl"))
		.filter((name) =>
			readFileSync(join(folder, name), "utf8").includes(`"customType":"${SESSION_RELEASED_ENTRY_TYPE}"`),
		)
		.map((name) => join(folder, name));
}
