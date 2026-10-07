import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { isBunBinary } from "../../config.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../core/extensions/builtin/monitor-state-event.ts";
import { takeOverStdout } from "../../core/output-guard.ts";
import { getDefaultSessionDir } from "../../core/session-manager.ts";
import { liveSessionWritePaths } from "../../core/session-write-reservation.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { registerWebViewBroker } from "../../core/webview/webview-broker.ts";
import { createCliRuntimeFactory } from "../../main.ts";
import { initTheme } from "../interactive/theme/theme.ts";
import { buildRpcSessionState } from "./connection-handler.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import { type RpcSessionEntry, RpcSessionRegistry } from "./session-registry.ts";
import { createWorkerCredit } from "./session-worker-credit.ts";
import {
	type HostToSessionWorker,
	SESSION_WORKER_LIMITS,
	type SessionWorkerToHost,
	type WorkerSnapshot,
} from "./session-worker-protocol.ts";

if (isBunBinary) {
	const { registerBunRuntimeModules } = await import("../../bun/runtime-modules.ts");
	registerBunRuntimeModules();
}

takeOverStdout();
registerWebViewBroker(Reflect.get(Object(workerData), "webviewBroker"));
const port = parentPort;
if (!port) throw new Error("Session worker requires a parent port");
const send = (message: SessionWorkerToHost): void => port.postMessage(message);

function failWorker(error: string): never {
	send({ type: "failure", error });
	process.exit(1);
}

const { exchange, installWriteReservation } = createWorkerCredit(send, failWorker);
// The host's key for the same file, so a deleted directory neither throws here nor misses (senpi#2285).
installWriteReservation(canonicalSessionPath);

class WorkerEventWriter extends SessionEventWriter {
	constructor() {
		super(() => {});
	}
	override enqueue(_sessionId: string, record: object): boolean {
		if (Buffer.byteLength(JSON.stringify(record)) > SESSION_WORKER_LIMITS.outputBytes)
			failWorker("session_worker_output_limit");
		const session = entry?.runtime?.session;
		if (!session) throw new Error("Session output preceded runtime creation");
		const activity = {
			busy: session.isSessionBusy,
			handoffBusy: isHandoffBusy(session.activitySnapshot),
			streaming: session.isStreaming,
		};
		const replacement =
			"type" in record &&
			(record.type === "session_replaced" ||
				record.type === "question_resolved" ||
				record.type === "question_updated" ||
				(record.type === "extension_ui_request" && "method" in record && record.method === "question"))
				? snapshot()
				: undefined;
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
let closing = false;
let unsubscribe: (() => void) | undefined;
let unsubscribeWake: (() => void) | undefined;

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
	const sessionPath = session.sessionFile ? canonicalSessionPath(session.sessionFile) : undefined;
	// The host releases every granted path this list omits, so it must name each writer
	// still alive in this isolate, plus the session the runtime currently writes.
	const live = new Set(liveSessionWritePaths().map(canonicalSessionPath));
	if (sessionPath) live.add(sessionPath);
	return {
		state: buildRpcSessionState(session),
		sessionPath,
		liveSessionPaths: [...live],
		busy: session.isSessionBusy,
		handoffBusy: isHandoffBusy(session.activitySnapshot),
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
			prepared = { ...message, profile: { ...message.profile, sessionPath: canonicalSessionPath(path) } };
			send({ type: "prepared", request: message.request, sessionPath: canonicalSessionPath(path) });
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
			const bindingEntry = entry;
			const createBinding = () =>
				createRpcSessionBinding(message.sessionId, bindingEntry, writer, () => send({ type: "request_close" }), {
					capabilities: message.capabilities,
					clientInfo: {
						connectionId: () => writer.currentConnection(),
						setCapabilities: (connection, capabilities) =>
							exchange(
								(signal) => ({ type: "capabilities", connection, capabilities, signal }),
								"session_worker_capabilities_denied",
							),
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
			const privileged =
				"type" in message.command &&
				["abort", "abort_bash", "extension_ui_response", "extension_ui_progress"].includes(
					String(message.command.type),
				);
			if (!binding || (closing && !privileged)) throw new Error("session_closing");
			const activeBinding = binding;
			await (message.connection === undefined
				? activeBinding.handle(message.command)
				: writer.withConnection(message.connection, () => activeBinding.handle(message.command)));
			publishSnapshot();
			send({ type: "result", request: message.request });
			return;
		}
		case "prompt_surface":
			if (!entry?.runtime) throw new Error("session_closing");
			entry.runtime.setPromptSurface(message.surface);
			send({ type: "result", request: message.request });
			return;
		case "browser_engine":
			if (!entry?.runtime) throw new Error("session_closing");
			entry.runtime.setBrowserEngine(message.engine);
			send({ type: "result", request: message.request });
			return;
		case "permission_preset":
			if (!entry?.runtime) throw new Error("session_closing");
			entry.runtime.setPermissionPreset(message.preset);
			send({ type: "result", request: message.request });
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
