/**
 * `open_session { forkFrom }` (omo#13031): the open forks a session this engine can read and answers like any open.
 * `forkFrom` names the source by its durable id, looked up in this host's own session folder as `find_session` does,
 * or by an absolute session file path. The fork is a new file in this host's session folder for the open's folder,
 * written by `SessionManager.forkFrom` (a new id, the source's entries up to now, `parentSession` naming the source),
 * and the open then opens that file. The source's file is only read.
 *
 * A source this engine cannot read is refused, typed, and nothing is opened: an id no session file of this host
 * carries is `fork_source_not_local` (it may live on another device or agent dir), and a path with no readable session
 * file, or an id two files carry, is `fork_source_not_found`. A fork never falls back to a plain new session.
 */
import { rm, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readHeaderCwd } from "../../core/session-header-cwd.ts";
import { getDefaultSessionDir, SessionManager } from "../../core/session-manager.ts";
import { findSessionFile } from "./find-session.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_INVALID_LAUNCH_PROFILE } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

const FORK_SOURCE_NOT_FOUND = "fork_source_not_found";
const FORK_SOURCE_NOT_LOCAL = "fork_source_not_local";

type OpenSessionCommand = Extract<RpcCommand, { type: "open_session" }>;

/** The open a fork becomes: the same command, now naming the fork's file and folder. `discard` removes that file. */
export interface ForkedOpen {
	readonly command: OpenSessionCommand;
	discard(): Promise<void>;
}

interface ForkSource {
	readonly path: string;
	readonly cwd: string | undefined;
}

async function forkSource(
	host: RouterContext,
	forkFrom: string,
	agentDir: string | undefined,
): Promise<ForkSource | { readonly refused: string; readonly detail?: string }> {
	if (isAbsolute(forkFrom)) {
		if ((await stat(forkFrom).catch(() => undefined))?.isFile() !== true)
			return { refused: FORK_SOURCE_NOT_FOUND, detail: "no session file at this path" };
		return { path: forkFrom, cwd: await readHeaderCwd(forkFrom) };
	}
	if (agentDir === undefined) return { refused: FORK_SOURCE_NOT_LOCAL, detail: "this host keeps no session folder" };
	const found = await findSessionFile({ agentDir, durableSessionId: forkFrom, hosted: host.registry.list() });
	if ("unknown" in found) return { refused: FORK_SOURCE_NOT_LOCAL };
	if ("ambiguous" in found) return { refused: FORK_SOURCE_NOT_FOUND, detail: "two session files carry this id" };
	return { path: found.found.sessionPath, cwd: found.found.cwd === "" ? undefined : found.found.cwd };
}

/**
 * The fork `command.forkFrom` asks for, written as a new session file, or the refusal the open answers. A command
 * without `forkFrom` is not a fork (`undefined`).
 */
export async function forkForOpen(
	host: RouterContext,
	command: OpenSessionCommand,
): Promise<ForkedOpen | RpcResponse | undefined> {
	const forkFrom = command.forkFrom;
	if (forkFrom === undefined) return undefined;
	if (forkFrom.trim() === "")
		return error(
			command.id,
			"open_session",
			`${RPC_ERROR_INVALID_LAUNCH_PROFILE}: forkFrom must be a non-empty string`,
		);
	if (command.sessionPath !== undefined)
		return error(
			command.id,
			"open_session",
			`${RPC_ERROR_INVALID_LAUNCH_PROFILE}: forkFrom creates a new session; it cannot also open sessionPath`,
		);
	const agentDir = host.registry.agentDir ?? host.defaults.agentDir;
	const source = await forkSource(host, forkFrom, agentDir);
	if ("refused" in source)
		return error(command.id, "open_session", source.refused, {
			forkFrom,
			...(source.detail === undefined ? {} : { detail: source.detail }),
		});
	const cwd = command.cwd ?? source.cwd ?? host.defaults.cwd;
	let forked: SessionManager;
	try {
		forked = SessionManager.forkFrom(
			source.path,
			cwd,
			agentDir === undefined ? undefined : getDefaultSessionDir(cwd, agentDir),
			command.durableSessionId === undefined ? undefined : { id: command.durableSessionId },
		);
	} catch (cause) {
		return error(command.id, "open_session", FORK_SOURCE_NOT_FOUND, {
			forkFrom,
			detail: cause instanceof Error ? cause.message : String(cause),
		});
	}
	const file = forked.getSessionFile();
	if (file === undefined)
		return error(command.id, "open_session", FORK_SOURCE_NOT_FOUND, { forkFrom, detail: "the fork wrote no file" });
	const { forkFrom: _forkFrom, ...open } = command;
	return {
		command: { ...open, sessionPath: file, cwd },
		discard: () => rm(file, { force: true }),
	};
}
