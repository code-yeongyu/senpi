/**
 * One terminal's control endpoint, from registration to clean exit. Loaded only when an extension
 * registers one (the interactive host imports it lazily), so a plain TUI pays nothing.
 *
 * Order matters and each step is undone on failure, so a failed bind leaves no half-registered
 * directory: the socket is bound (secret 0600, directory 0700) while the session header is made
 * durable, and only once both are done is the endpoint registered - a visible endpoint is one that
 * answers, and its session id is already on disk. Nothing a sender needs waits on work it does not
 * need: the writer stamp's process lookup starts at entry, the inbox watch arms after registration
 * returned, and dead `tui` endpoints of other terminals are reaped after activation. Wakes come
 * from edges only (see `session-control-wake.ts`).
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type {
	RegisterControlEndpointOptions,
	SessionControlDrainResult,
	SessionControlRegistration,
	SessionControlWakeReason,
} from "../../core/extensions/types.ts";
import { thisProcessStartTime } from "../rpc/host-daemon-registration.ts";
import { gcHostEndpoints } from "../rpc/host-gc.ts";
import { createSocketSecret, socketSecretPath } from "../rpc/socket-transport.ts";
import { runControlCommand } from "./session-control-commands.ts";
import { ControlFeed } from "./session-control-feed.ts";
import {
	type ActiveControlEndpoint,
	activateControlEndpoint,
	type TuiControlContext,
} from "./session-control-lifecycle.ts";
import { registerTuiEndpoint, resolveTuiSocket, unregisterTuiEndpoint } from "./session-control-registry.ts";
import { listenControlSocket } from "./session-control-server.ts";
import { WakeScheduler, watchInbox } from "./session-control-wake.ts";

export type { ActiveControlEndpoint, TuiControlContext } from "./session-control-lifecycle.ts";

type Registered = Extract<SessionControlRegistration, { readonly status: "registered" }>;
type NotRegistered = Exclude<SessionControlRegistration, { readonly status: "registered" }>;

export type ControlEndpointOutcome =
	| { readonly registration: Registered; readonly endpoint: ActiveControlEndpoint }
	| { readonly registration: NotRegistered };

type Cleanup = () => Promise<void> | void;

export async function registerSessionControlEndpoint(
	context: TuiControlContext,
	options: RegisterControlEndpointOptions,
): Promise<ControlEndpointOutcome> {
	const cleanups: Cleanup[] = [];
	try {
		const endpoint = await openEndpoint(context, options, cleanups);
		return { registration: { status: "registered", socket: endpoint.socket, dispose: endpoint.dispose }, endpoint };
	} catch (error) {
		for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
		const reason = errorText(error);
		context.surface.notice(`control endpoint unavailable: ${reason}`);
		return { registration: { status: "failed", reason } };
	}
}

async function openEndpoint(
	context: TuiControlContext,
	options: RegisterControlEndpointOptions,
	cleanups: Cleanup[],
): Promise<ActiveControlEndpoint> {
	const { session, agentDir, surface } = context;
	// The writer stamp's `ps` lookup is a process constant: started here, it overlaps the header write
	// and the bind instead of running inside the registry lock.
	void thisProcessStartTime();
	// Bound while the header is written, awaited before the endpoint is registered.
	const headerDurable = session.sessionManager.persistHeaderNow();
	headerDurable.catch(() => undefined);
	const instanceId = randomUUID();
	const socket = await resolveTuiSocket(agentDir, instanceId);
	cleanups.push(
		() => rm(socket, { force: true }),
		() => rm(socketSecretPath(socket), { force: true }),
	);
	const secret = await createSocketSecret(socketSecretPath(socket));
	const feed = new ControlFeed();
	const scheduler = new WakeScheduler(
		async (event) => {
			await session.extensionRunner.emit(event);
			return (await options.drain(event)) ?? { admitted: [] };
		},
		(error) => surface.notice(`control endpoint drain failed: ${errorText(error)}`),
	);
	cleanups.push(() => scheduler.dispose());
	const wake = (reason: SessionControlWakeReason, ids?: readonly string[]): Promise<SessionControlDrainResult> =>
		scheduler.request(reason, ids);
	const commandContext = {
		instanceId,
		session,
		surface,
		feed,
		wake: (ids?: readonly string[]) => wake("command", ids),
	};
	const server = await listenControlSocket(socket, secret, {
		command: (connection, command) => runControlCommand(commandContext, connection, command),
		closed: (connection) => feed.unsubscribe(connection.id),
		listenerError: (error) => surface.notice(`control endpoint listener failed: ${error.message}`),
	});
	cleanups.push(() => server.close());
	await headerDurable;
	const entry = await registerTuiEndpoint({ agentDir, socket, instanceId });
	cleanups.push(() => unregisterTuiEndpoint(entry));
	const inbox = await watchInbox(
		options.inboxDir,
		() => void wake("inbox"),
		(error) => surface.notice(`control endpoint inbox watch failed: ${errorText(error)}`),
	);
	cleanups.push(() => inbox.stop());
	const endpoint = activateControlEndpoint({
		context,
		options,
		entry,
		server,
		scheduler,
		feed,
		stopInbox: inbox.stop,
		wake,
	});
	// Anything that reached the inbox before this point is picked up by this first pass, and anything
	// written after it but before the watch was armed (no event for it) by the pass once arming settled.
	endpoint.wake("inbox");
	void inbox.armed.then(() => endpoint.wake("inbox"));
	// Other terminals' dead records are nothing a sender reads: reaped after activation, off the path.
	setImmediate(() => {
		gcHostEndpoints(agentDir, { kinds: ["tui"] }).catch((error: unknown) =>
			surface.notice(`control endpoint gc of dead terminals failed: ${errorText(error)}`),
		);
	});
	return endpoint;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
