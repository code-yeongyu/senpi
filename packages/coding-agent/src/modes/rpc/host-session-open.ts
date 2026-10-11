import type { EnsuredHost } from "./host-ensure.ts";
import { HOST_EXIT_OK, type HostOutcome } from "./host-outcome.ts";
import { mapError } from "./host-session-errors.ts";
import type { RpcClient } from "./rpc-client.ts";

export interface HostSessionOpen {
	cwd: string;
	model?: { provider: string; id: string };
	name?: string;
	prompt?: string;
}

/** Open a retained session; a later step that fails closes it again, or names it when that close fails. */
export async function openHostSession(
	client: RpcClient,
	request: HostSessionOpen,
	socket: string,
	ensured: EnsuredHost | undefined,
): Promise<HostOutcome> {
	const opened = await client.openSession({
		cwd: request.cwd,
		retain_on_disconnect: true,
		...(request.model && { provider: request.model.provider, modelId: request.model.id }),
	});
	ensured?.release();
	const { state } = opened;
	const identity = { sessionId: opened.sessionId, sessionPath: state.sessionFile, durableSessionId: state.sessionId };
	try {
		if (request.name !== undefined) await client.setSessionName(request.name);
		const disposition = request.prompt === undefined ? undefined : await client.prompt(request.prompt);
		return {
			exitCode: HOST_EXIT_OK,
			payload: {
				action: "open",
				socket,
				pid: ensured?.pid,
				reused: ensured?.reused,
				...identity,
				cwd: state.cwd,
				model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
				attached: opened.attached ?? false,
				...(disposition !== undefined && { prompt: { disposition } }),
			},
		};
	} catch (error) {
		const outcome = mapError(error, socket);
		const closed = await closeOpened(client, opened.sessionId);
		return { ...outcome, payload: { ...outcome.payload, ...identity, closed } };
	}
}

async function closeOpened(client: RpcClient, sessionId: string): Promise<boolean> {
	try {
		await client.closeSession(sessionId);
		return !(await client.listSessions()).some((row) => row.sessionId === sessionId);
	} catch {
		// `closed: false` plus the ids in the payload is how the caller learns it must close it.
		return false;
	}
}
