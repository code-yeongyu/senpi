import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { WAKE_SOURCE_STATE_EVENT } from "../../core/extensions/builtin/monitor-state-event.ts";
import { takeOverStdout } from "../../core/output-guard.ts";
import { getDefaultSessionDir } from "../../core/session-manager.ts";
import { installSessionWriteReservation } from "../../core/session-write-reservation.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createCliRuntimeFactory } from "../../main.ts";
import { initTheme } from "../interactive/theme/theme.ts";
import { buildRpcSessionState } from "./connection-handler.ts";
import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { type RpcSessionEntry, RpcSessionRegistry } from "./session-registry.ts";
import {
	type HostToSessionWorker,
	SESSION_WORKER_LIMITS,
	type SessionWorkerToHost,
	type WorkerDisplay,
	type WorkerSnapshot,
} from "./session-worker-protocol.ts";

takeOverStdout();
const port = parentPort;
if (!port) throw new Error("Session worker requires a parent port");
const send = (message: SessionWorkerToHost): void => port.postMessage(message);

function failWorker(error: string): never {
	send({ type: "failure", error });
	process.exit(1);
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
}

function exchange(
	message: (signal: SharedArrayBuffer) => SessionWorkerToHost,
	deniedError = "session_worker_output_denied",
	signal = new SharedArrayBuffer(4),
): void {
	const state = new Int32Array(signal);
	send(message(signal));
	Atomics.wait(state, 0, 0, SESSION_WORKER_LIMITS.controlMs);
	const result = Atomics.load(state, 0);
	if (result === 2) {
		if (deniedError === "session_path_in_use") throw new Error(deniedError);
		failWorker(deniedError);
	}
	if (result !== 1) failWorker("session_worker_credit_timeout");
}

installSessionWriteReservation((path) => {
	const canonical = canonicalPath(path);
	const signal = new SharedArrayBuffer(8);
	exchange((signal) => ({ type: "reserve", path: canonical, signal }), "session_path_in_use", signal);
	if (Atomics.load(new Int32Array(signal), 1) !== 1) return undefined;
	return () => exchange((signal) => ({ type: "release_reservation", path: canonical, signal }));
});

class WorkerEventWriter extends SessionEventWriter {
	constructor() {
		super(() => {});
	}
	override enqueue(_sessionId: string, record: object): boolean {
		if (Buffer.byteLength(JSON.stringify(record)) > SESSION_WORKER_LIMITS.outputBytes)
			failWorker("session_worker_output_limit");
		const session = entry?.runtime?.session;
		if (!session) throw new Error("Session output preceded runtime creation");
		const activity = { busy: session.isSessionBusy, streaming: session.isStreaming };
		const replacement = "type" in record && record.type === "session_replaced" ? snapshot() : undefined;
		if (replacement && Buffer.byteLength(JSON.stringify(replacement)) > SESSION_WORKER_LIMITS.outputBytes)
			failWorker("session_worker_snapshot_limit");
		exchange((signal) => ({
			type: "output",
			record,
			connection: this.currentConnection(),
			signal,
			activity,
			snapshot: replacement,
		}));
		return true;
	}
}

const writer = new WorkerEventWriter();
let prepared: Extract<HostToSessionWorker, { type: "prepare" }> | undefined;
let registry: RpcSessionRegistry | undefined;
let entry: RpcSessionEntry | undefined;
let binding: RpcSessionBinding | undefined;
let display: WorkerDisplay = { revision: 0, width: 80, rendered: false, capabilities: [] };
let closing = false;
let unsubscribe: (() => void) | undefined;
let unsubscribeWake: (() => void) | undefined;

function applyDisplay(next: WorkerDisplay): boolean {
	if (next.revision < display.revision) return false;
	display = next;
	return true;
}

function updateDisplay(message: (signal: SharedArrayBuffer) => SessionWorkerToHost): void {
	const signal = new SharedArrayBuffer(24);
	exchange(message, "session_worker_display_denied", signal);
	const values = new Float64Array(signal);
	applyDisplay({
		...display,
		width: values[1],
		revision: values[2],
		rendered: Atomics.load(new Int32Array(signal), 1) === 1,
	});
}

function publishSnapshot(settled = false): void {
	const value = snapshot();
	if (Buffer.byteLength(JSON.stringify(value)) > SESSION_WORKER_LIMITS.outputBytes)
		failWorker("session_worker_snapshot_limit");
	exchange((signal) => ({ type: "snapshot", snapshot: value, signal, settled }));
}

function subscribeSession(): void {
	unsubscribe?.();
	unsubscribeWake?.();
	unsubscribeWake = entry?.runtime?.session.extensionRunner.onBusEvent(WAKE_SOURCE_STATE_EVENT, () =>
		publishSnapshot(),
	);
	unsubscribe = entry?.runtime?.session.subscribe((event) =>
		publishSnapshot(event.type === "agent_settled" || event.type === "agent_idle"),
	);
}

function snapshot(): WorkerSnapshot {
	if (!entry?.runtime) throw new Error("Session runtime is not ready");
	const session = entry.runtime.session;
	return {
		state: buildRpcSessionState(session),
		sessionPath: session.sessionFile ? canonicalPath(session.sessionFile) : undefined,
		busy: session.isSessionBusy,
		streaming: session.isStreaming,
	};
}

async function handle(message: HostToSessionWorker): Promise<void> {
	switch (message.type) {
		case "prepare": {
			if (prepared) throw new Error("Session worker already prepared");
			const path =
				message.profile.sessionPath ??
				join(
					getDefaultSessionDir(message.profile.cwd, message.configuration.agentDir),
					`${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`,
				);
			prepared = { ...message, profile: { ...message.profile, sessionPath: canonicalPath(path) } };
			send({ type: "prepared", request: message.request, sessionPath: canonicalPath(path) });
			return;
		}
		case "commit": {
			if (!prepared || registry) throw new Error("Invalid session commit");
			const startupSettingsManager = SettingsManager.create(
				prepared.configuration.cwd,
				prepared.configuration.agentDir,
			);
			const factory = createCliRuntimeFactory(prepared.configuration, { startupSettingsManager });
			initTheme(startupSettingsManager.getTheme(), false);
			registry = new RpcSessionRegistry({ agentDir: prepared.configuration.agentDir, createRuntime: factory });
			const opened = await registry.openSession(prepared.profile);
			entry = registry.getForCommand(opened.sessionId, "open_session");
			send({ type: "ready", request: message.request, snapshot: snapshot() });
			return;
		}
		case "bind": {
			if (!entry || binding) throw new Error("Invalid session binding");
			display = message.display;
			const bindingEntry = entry;
			const createBinding = () =>
				createRpcSessionBinding(message.sessionId, bindingEntry, writer, () => send({ type: "request_close" }), {
					capabilities: display.capabilities,
					sharedWidth: {
						getWidth: () => display.width,
						setWidth: (connection, width) =>
							updateDisplay((signal) => ({ type: "width", connection, width, signal })),
						onChange: () => binding?.rerenderComponents?.(),
						clearWidth: () => {},
						connectionId: () => writer.currentConnection(),
						hasRenderedComponents: () => display.rendered,
						setCapabilities: (connection, capabilities) => {
							updateDisplay((signal) => ({ type: "capabilities", connection, capabilities, signal }));
							binding?.rerenderComponents?.();
						},
					},
				});
			binding = await (message.connection === undefined
				? createBinding()
				: writer.withConnection(message.connection, createBinding));
			const rebind = entry.rebindSession;
			entry.rebindSession = async (session) => {
				await rebind?.(session);
				subscribeSession();
			};
			entry.runtime?.setRebindSession(entry.rebindSession);
			subscribeSession();
			publishSnapshot();
			send({ type: "result", request: message.request });
			return;
		}
		case "command": {
			if (!binding || closing) throw new Error("session_closing");
			applyDisplay(message.display);
			const activeBinding = binding;
			await (message.connection === undefined
				? activeBinding.handle(message.command)
				: writer.withConnection(message.connection, () => activeBinding.handle(message.command)));
			publishSnapshot();
			send({ type: "result", request: message.request });
			return;
		}
		case "display":
			if (applyDisplay(message.display)) binding?.rerenderComponents?.();
			send({ type: "control_done", control: "display" });
			return;
		case "cancel_ui":
			binding?.cancelPendingExtensionUiRequests?.();
			send({ type: "control_done", control: "cancel_ui" });
			return;
		case "close":
			closing = true;
			unsubscribe?.();
			unsubscribeWake?.();
			await binding?.dispose();
			if (entry?.runtime) {
				const current = entry;
				await runWithProviderScope(current.scope, async () => {
					await current.runtime?.session.abort();
					await current.runtime?.session.waitForIdle();
					await current.runtime?.dispose();
					await current.scope.close();
				});
			}
			process.exit(0);
	}
}

port.on("message", (message: HostToSessionWorker) => {
	void handle(message).catch((cause: unknown) => {
		const error = cause instanceof Error ? cause.message : String(cause);
		if (error.startsWith("session_worker_")) {
			send({ type: "failure", error });
			process.exit(1);
		}
		if ("request" in message) send({ type: "result", request: message.request, error });
		else {
			send({ type: "failure", error });
			process.exit(1);
		}
	});
});
