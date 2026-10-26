import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getAgentDir } from "../../../../config.ts";
import {
	ManagedLaunchError,
	SessionLaunchSupervisor,
} from "../../../../modes/rpc/tool-child/session-launch-supervisor.ts";
import { SessionServices } from "../../../../modes/rpc/tool-child/session-services.ts";
import { getShellEnv } from "../../../../utils/shell.ts";
import { encodedSessionId } from "../../../session-sidecar-store.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { probeSessionService } from "./service-probe.ts";

const serviceSchema = Type.Object({
	action: Type.Union([Type.Literal("ensure"), Type.Literal("stop"), Type.Literal("list")]),
	key: Type.Optional(
		Type.String({ minLength: 1, description: "Stable service identity, including its endpoint/home." }),
	),
	command: Type.Optional(
		Type.String({ minLength: 1, description: "Foreground executable. Do not daemonize or detach." }),
	),
	args: Type.Optional(Type.Array(Type.String())),
	cwd: Type.Optional(
		Type.String({ description: "Stable working directory for this service; defaults to the session directory." }),
	),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	client_env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"The caller's client settings: applied to the service and the probe, and returned for subsequent client calls.",
		}),
	),
	probe: Type.Optional(
		Type.Object({
			command: Type.String({ minLength: 1 }),
			args: Type.Array(Type.String()),
			absent_message: Type.String({
				minLength: 1,
				description: "Documented literal absence marker. Other failures stop startup.",
			}),
		}),
	),
});

interface ServiceSession {
	readonly supervisor: SessionLaunchSupervisor;
	readonly services: SessionServices;
	readonly dir: string;
}

// The host owns these across extension reloads. Another host's daemon is only an external probe result.
const sessions = new Map<string, ServiceSession>();
const closedSessions = new Set<string>();

// SDK disposal also seals services, even when no mode emitted session_shutdown first.
registerSessionResourceCleanup((sessionId) => {
	// Provider-wide resets without an id are not session termination.
	if (sessionId === undefined) return;
	closedSessions.add(sessionId);
	const session = sessions.get(sessionId);
	sessions.delete(sessionId);
	void session?.services.close().catch((error: unknown) => {
		process.stderr.write(
			`managed service cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	});
});

function serviceSession(ctx: ExtensionContext): ServiceSession {
	const id = ctx.sessionManager.getSessionId();
	if (closedSessions.has(id)) throw new ManagedLaunchError("managed_session_closed", "the session has ended");
	const found = sessions.get(id);
	if (found !== undefined) return found;
	const dir = join(getAgentDir(), "managed-services", encodedSessionId(id));
	const supervisor = new SessionLaunchSupervisor({ dir });
	const session = { supervisor, services: new SessionServices(supervisor), dir };
	sessions.set(id, session);
	return session;
}

export function registerSessionServiceTool(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const id = ctx.sessionManager?.getSessionId?.();
		if (id !== undefined) closedSessions.delete(id);
	});
	pi.registerTool({
		name: "session_service",
		label: "Session service",
		description:
			"Ensure a foreground daemon as a session-owned service, or reuse an external daemon without adopting it. " +
			"An optional probe reuses on success and starts only on its documented absent_message; every other error stops. " +
			"Returns started, not ready: verify readiness separately. stop releases only this session's lease; " +
			"external daemons are never killed. A key names one daemon per home: a different environment is another daemon. " +
			"client_env is applied to service and probe; apply the returned client_env in subsequent calls too. " +
			"If ensure reports exited, stop then ensure again.",
		parameters: serviceSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const session = serviceSession(ctx);
			if (params.action === "list") {
				const services = await session.services.list();
				return { content: [{ type: "text", text: JSON.stringify(services) }], details: { services } };
			}
			const key = params.key;
			if (key === undefined) throw new ManagedLaunchError("managed_service_parameters", "key is required");
			if (params.action === "stop") {
				await session.services.release(key);
				return { content: [{ type: "text", text: `Released this session's lease for ${key}.` }], details: { key } };
			}
			if (params.command === undefined)
				throw new ManagedLaunchError("managed_service_parameters", "ensure requires a foreground command");
			const clientEnv = params.client_env ?? {};
			const env: NodeJS.ProcessEnv = { ...getShellEnv(), ...params.env, ...clientEnv };
			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			const logPath = join(session.dir, `${createHash("sha256").update(key).digest("hex")}.log`);
			const probe = params.probe;
			const result = await session.services.ensure(key, {
				command: { command: params.command, args: params.args ?? [], cwd, env, logPath },
				...(probe === undefined
					? {}
					: {
							probe: () =>
								probeSessionService(
									session.supervisor,
									{
										command: probe.command,
										args: probe.args,
										cwd,
										env,
										logPath: join(session.dir, `probe-${randomUUID()}.log`),
									},
									probe.absent_message,
								),
						}),
			});
			const details = { ...result, client_env: clientEnv };
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
				...(result.state === "exited" ? { isError: true } : {}),
			};
		},
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "reload") return;
		// Minimal SDK contexts without a session manager cannot have registered a service.
		const id = ctx.sessionManager?.getSessionId?.();
		if (id === undefined) return;
		closedSessions.add(id);
		const session = sessions.get(id);
		sessions.delete(id);
		await session?.services.close();
	});
}
