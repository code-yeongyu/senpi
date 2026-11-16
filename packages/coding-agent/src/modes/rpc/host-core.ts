import { envValue } from "../../core/brand.ts";
import { HostMcpRegistry } from "../../core/extensions/builtin/mcp/host-registry.ts";
import type { SessionContext } from "../../core/extensions/types.ts";
import type { MultiSessionHostOptions } from "./multi-session-host.ts";
import { CommandAuthority, commandAuthority, takeRelayExec } from "./command-authority.ts";
import { answerDelegation, relayExecRefusal } from "./delegated-answer.ts";
import { parseClientCapabilities } from "./custom-capability.ts";
import { HostCoreGate, type HostCoreHooks } from "./host-core-gate.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { reopenHandoverParkedSessions } from "./host-handover-reopen.ts";
import { type HostIdleOverrides, RPC_CLOSE_GRACE_MS_ENV, resolveHostIdlePolicy } from "./host-idle-policy.ts";
import { hostWatchdogBinding } from "./host-internal-transport.ts";
import { parseIdleExitMs } from "./host-lifecycle.ts";
import { hostLog, parseError } from "./host-output.ts";
import { createEndpointReservations } from "./host-reservations.ts";
import { MachineOpHandler } from "./machine-op/handler.ts";
import { withOpenRetention } from "./open-retention.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import { rpcCommandShapeError } from "./rpc-input-validation.ts";
import type { RpcCommand } from "./rpc-types.ts";
import { SessionCommandRouter } from "./session-command-router.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import { RpcSessionRegistry, RpcSessionRegistryError } from "./session-registry.ts";
import { resolveSocketPath } from "./host-socket-bind.ts";
import { WorkerSessionRegistry } from "./worker-session-registry.ts";

export function createHostCore(
	options: MultiSessionHostOptions,
	writer: SessionEventWriter,
	capabilities = parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")),
	idle: HostIdleOverrides = {},
	hostContext?: SessionContext,
	hooks: HostCoreHooks = {},
) {
	if (options.mcpPresenterEnforcement === true) writer.enableMcpPresenters();
	const machineOwned = options.sessionOwner === "machine";
	const policy = resolveHostIdlePolicy(
		process.env,
		machineOwned ? { ...idle, emptyExitMs: Number.POSITIVE_INFINITY } : idle,
	);
	const endpointSocket = publicEndpointSocket(options);
	const pathReservations = createEndpointReservations({
		agentDir: options.agentDir,
		socket: listenSocketPath(options),
		instanceId: hostInstanceId(),
		publicSocket: hostContext?.host_socket,
		onFailure: hostLog,
	});
	const registry = options.workerConfiguration
		? new WorkerSessionRegistry({
				configuration: options.workerConfiguration,
				now: policy.now,
				closeGraceMs: idle.closeGraceMs ?? parseIdleExitMs(process.env[RPC_CLOSE_GRACE_MS_ENV]) ?? 10_000,
				pathReservations,
			})
		: new RpcSessionRegistry({
				agentDir: options.agentDir,
				createRuntime: options.createRuntime,
				mcpRegistry: new HostMcpRegistry(),
				now: policy.now,
				closeGraceMs: idle.closeGraceMs ?? parseIdleExitMs(process.env[RPC_CLOSE_GRACE_MS_ENV]) ?? 10_000,
				// Two generations of this daemon can be alive at once during a handoff; the claims
				// they publish here are what keeps them off one session file.
				...(hooks.onSessionCountChange ? { onSizeChange: hooks.onSessionCountChange } : {}),
				pathReservations,
			});
	const machineOps = new MachineOpHandler({ agentDir: options.agentDir });
	const router = new SessionCommandRouter(
		registry,
		writer,
		hostContext ? { ...options, hostContext } : options,
		options.createBinding,
		{ capabilities },
		{
			now: policy.now,
			idleEvictionMs: policy.idleEvictionMs,
			emptyExitMs: policy.emptyExitMs,
			// Held in the same step as the exit decision: no machine op may start on a host that is ending (senpi#6752).
			onEmptyExit:
				idle.onEmptyExit === undefined
					? undefined
					: () => {
							machineOps.hold();
							idle.onEmptyExit?.();
						},
			onHandoffParked: idle.onHandoffParked,
			...(endpointSocket === undefined
				? {}
				: {
						handoverParkedDir: createHostDaemonPaths({
							socket: endpointSocket,
							agentDir: options.agentDir,
						}).dir,
					}),
			// The host's own gate first, then machine work: an empty exit would end every relay-host terminal (senpi#6752).
			canExitWhenEmpty: () => (idle.canExitWhenEmpty?.() ?? true) && !machineOps.busy(),
		},
	);
	if (endpointSocket !== undefined)
		reopenHandoverParkedSessions(
			async (entry) => {
				const refused = await router.reopenParked(entry);
				if (refused?.success !== false) return;
				const detail =
					typeof refused.errorData === "object" && refused.errorData !== null && !Array.isArray(refused.errorData)
						? Object.fromEntries(Object.entries(refused.errorData))
						: undefined;
				throw refused.error === "session_path_in_use"
					? new RpcSessionRegistryError("session_path_in_use", undefined, detail)
					: new RpcSessionRegistryError("open_failed", refused.error);
			},
			options.agentDir,
			endpointSocket,
			{
				hostInstance: hostInstanceId(),
				hostSocket: endpointSocket,
				...(hooks.shouldReopenParked !== undefined ? { shouldReopen: hooks.shouldReopenParked } : {}),
			},
		).catch((cause: unknown) => {
			process.stderr.write(`senpi rpc successor reopen parked set failed: ${String(cause)}\n`);
		});
	const gate = new HostCoreGate(registry, (command) => router.handle(command), {
		...hooks,
		machineWork: machineOps,
		conditionalDrain: (instanceId) => {
			const decision = router.closeIdleDrainAdmission(instanceId);
			switch (decision.action) {
				case "drained":
					machineOps.hold();
					if (hooks.onConditionalDrain) hooks.onConditionalDrain();
					else router.beginDrain();
					return decision;
				case "refuse":
					return decision;
				default:
					throw new Error("Unknown conditional drain decision", { cause: decision satisfies never });
			}
		},
	});
	const handle = async (line: string): Promise<void> => {
		const connection = writer.currentConnection();
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			await writer.enqueueControl(
				writer.delegations.unparsable(connection, "Failed to parse command: invalid JSON"),
			);
			return;
		}
		// omo-relay-daemon#307: a host-mode delegated line runs under one authority snapshot, its forwarder's `relayExec`
		// taken out of the record before anything else reads it.
		const delegation = writer.connectionContext.delegation;
		if (delegation?.mode !== "host") return handleParsed(connection, parsed);
		const exec = takeRelayExec(parsed);
		if (exec === "malformed") {
			await writer.enqueueControl(relayExecRefusal(parsed));
			return;
		}
		return commandAuthority.run(new CommandAuthority(connection, delegation, exec), () =>
			handleParsed(connection, parsed),
		);
	};
	const handleParsed = async (connection: string | undefined, parsed: unknown): Promise<void> => {
		// Before any await: a declaration takes effect for the very next line of its connection (senpi#5632).
		const delegation = writer.delegations.inspect(connection, parsed);
		if (delegation.kind === "machine_op") {
			await writer.enqueueControl(await machineOps.answer(delegation.command, parsed, delegation.id));
			return;
		}
		if (delegation.kind !== "pass") {
			await answerDelegation(writer, delegation, parsed);
			return;
		}
		// A delegated connection ends with the viewer it forwards for, while the forwarder keeps serving what it opened to
		// the next one: every open on it is retained, whatever it asks, so its end detaches and never closes (senpi#5808).
		// Read at line receipt, so a connection that ends before the open is dispatched still counts as delegated.
		const delegated = writer.delegations.isDelegated(connection);
		if (writer.handleMcpForm(parsed)) return;
		if (await gate.intercept(parsed, (answer) => writer.enqueueControl(answer))) return;
		const shapeError = rpcCommandShapeError(parsed);
		if (shapeError) {
			await writer.enqueueControl(parseError(shapeError));
			return;
		}
		const command = parsed as RpcCommand;
		const response = await gate.dispatch(withOpenRetention(command, delegated, machineOwned));
		if (response) await writer.enqueueControl(response);
		writer.delegations.lineAnswered(connection);
	};
	return {
		router,
		handle,
		/** senpi#6752: the host's `machine_op` handler; its terminals end at host shutdown. */
		machineOps,
		handover: gate.handover,
		handoverAnswered: () => gate.answered(),
		/** The in-process registry's `warm`; the worker registry has none. */
		warm: "warm" in registry ? registry.warm : undefined,
		/**
		 * A session's live registry entry by its routing id. Only in-process test fixtures read it today, in place of
		 * spying on the registry prototype (senpi#5802); the host itself never calls it.
		 */
		peekSession: (sessionId: string) => registry.peek(sessionId),
	};
}

/** The endpoint this host listens on, or nothing when it speaks stdio and shares no socket. */
function listenSocketPath(options: MultiSessionHostOptions): string | undefined {
	if (options.listen === undefined || options.listen === "stdio://") return undefined;
	return resolveSocketPath(options.listen, options.agentDir);
}

/**
 * The PUBLIC endpoint clients address, matching `hostSessionContext`: a supervised host's own
 * listener is a private hop, so the daemon-directory key must come from the supervisor's public
 * socket or every generation hashes a different directory (senpi#3282). Bare hosts bind the path.
 */
function publicEndpointSocket(options: MultiSessionHostOptions): string | undefined {
	const supervised = hostWatchdogBinding();
	if (supervised !== undefined) return supervised.publicSocket;
	return listenSocketPath(options);
}
