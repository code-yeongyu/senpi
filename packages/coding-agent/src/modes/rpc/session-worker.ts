import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { captureAdmissionReply } from "./compact-admission-reply.ts";
import { workerAdmissionCommand } from "./worker-admission-command.ts";
import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { isBunBinary } from "../../config.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { attachMcpGrantPresentation } from "../../core/mcp-grant-presentations.ts";
import { takeOverStdout } from "../../core/output-guard.ts";
import type { SecurityNoticeSnapshot } from "../../core/security-notices.ts";
import { recoveryCarrier, setSessionRecoveryEpoch } from "../../core/session-recovery-identity.ts";
import { getDefaultSessionDir, type SessionManager } from "../../core/session-manager.ts";
import { subscriptionLimits } from "../../core/subscription-limits/limit-store.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { registerWebViewBroker } from "../../core/webview/webview-broker.ts";
import { createCliRuntimeFactory } from "../../main.ts";
import { initTheme } from "../interactive/theme/theme.ts";
import { ConnectionRoles, roleConnection } from "./connection-roles.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";
import { structuredLaneEnabled } from "./structured-session-records.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import type { RpcSessionEntry, RpcSessionRegistry } from "./session-registry.ts";
import { resolveMovedProfile } from "./session-registry-moved-path.ts";
import { createWorkerCredit } from "./session-worker-credit.ts";
import { workerSnapshot } from "./session-worker-snapshot.ts";
import { WorkerTransfer } from "./session-worker-transfer.ts";
import { type CanonicalControl, carriedCanonical, carriedRefusal } from "./compact-canonical-pairing.ts";
import { COMPACT_PROTOCOL_MAX_DEPTH, protocolDepthLimitOf } from "./compact-protocol-depth.ts";
import { legacyJsonText } from "./jsonl.ts";
import { jsonTextDeeperThan } from "./legacy-record-depth.ts";
import { CompactProducerStamp } from "./compact-producer-stamp.ts";
import {
	type HostToSessionWorker,
	SESSION_WORKER_LIMITS,
	type SessionWorkerToHost,
	withinFrameLimit,
} from "./session-worker-protocol.ts";
import { createSessionWorkerRegistry } from "./session-worker-registry.ts";
import { IssuedWorkerOwners } from "./session-worker-owners.ts";
import { McpFormWorker } from "./mcp-form-worker.ts";
import type { SecretInputRoute } from "./secret-input-requests.ts";
import type { SecretInputUnavailableReason } from "../../core/extensions/secret-input.ts";

if (isBunBinary) {
	const { registerBunRuntimeModules } = await import("../../bun/runtime-modules.ts");
	registerBunRuntimeModules();
}

takeOverStdout();
registerWebViewBroker(Reflect.get(Object(workerData), "webviewBroker"));
const port = parentPort;
// Reply identity follows the command across the isolate without a per-request lookup table.
if (!port) throw new Error("Session worker requires a parent port");
const send = (message: SessionWorkerToHost): void => port.postMessage(message);
const privateForms = new McpFormWorker(send);
let privateFormsEnforced = false;

function failWorker(error: string): never {
	send({ type: "failure", error });
	process.exit(1);
}

const { exchange, transfer, post, installTransport, installWriteReservation } = createWorkerCredit(send, failWorker);
// The host's key for the same file, so a deleted directory neither throws here nor misses (senpi#2285).
installWriteReservation(canonicalSessionPath);

class WorkerEventWriter extends SessionEventWriter {
	readonly secretCancels = new Map<string, () => void>();
	override secretInputRoute(_sessionId: string): SecretInputRoute {
		const presenters = new Map<string, string | undefined>();
		return {
			select: (id, unavailable) => {
				const decision = new SharedArrayBuffer(8192);
				exchange((signal) => ({
					type: "secret_select",
					id,
					connection: this.currentConnection(),
					decision,
					signal,
				}));
				const length = new Int32Array(decision, 0, 1)[0];
				const result = JSON.parse(new TextDecoder().decode(new Uint8Array(decision, 4, length))) as
					| { accepted: true; connection?: string }
					| { accepted: false; reason: SecretInputUnavailableReason };
				if (!result.accepted) return result.reason;
				presenters.set(id, result.connection);
				this.secretCancels.set(id, unavailable);
				return undefined;
			},
			presenter: (id) => presenters.get(id),
			// The parent authorizes the actual sender before forwarding a response into this isolate.
			accepts: (id) => presenters.has(id) && presenters.get(id) === this.currentConnection(),
			available: (id) => presenters.has(id),
			send: (id, record) => exchange((signal) => ({ type: "secret_frame", id, record, signal })),
			settled: (id) => {
				this.secretCancels.delete(id);
				exchange((signal) => ({ type: "secret_settled", id, signal }));
			},
			forget: (id) => {
				this.secretCancels.delete(id);
				presenters.delete(id);
				exchange((signal) => ({ type: "secret_forget", id, signal }));
			},
			handshake: (capabilities) => {
				if (this.currentConnection() === undefined)
					exchange((signal) => ({ type: "secret_handshake", capabilities, signal }));
			},
		};
	}
	override bindMcpForms(_sessionId: string, durableId: string, ui: object, admit: () => void) {
		return privateFormsEnforced ? privateForms.bind(durableId, ui, admit) : undefined;
	}
	override readonly workerSecurityBridge = true;
	constructor() {
		super(() => {});
	}
	override bindSecurityPresentations(
		sessionId: string,
		durableId: string,
		notices: SecurityNoticeSnapshot,
		ui: ExtensionUIContext,
	): () => void {
		const detach = attachMcpGrantPresentation(durableId, ui.select);
		const stop = notices.subscribe((snapshot) => {
			this.enqueue(sessionId, { type: "security_notice_snapshot", snapshot });
		});
		return () => {
			detach();
			stop();
		};
	}
	override settleGrantDialog(sessionId: string, id: string): void {
		this.enqueue(sessionId, { type: "security_grant_settled", id });
	}
	override publishLoadedSurfacesChanged(_sessionId: string, previous: string | undefined, digest: string): void {
		// The isolate never emits the event itself: the host owns the per-(connection, session)
		// dedupe across every attachment, so a connection attached to several worker sessions
		// hears one notice per inventory change on either runtime (#3198 review, L5).
		exchange((signal) => ({
			type: "loaded_surfaces",
			...(previous === undefined ? {} : { previous }),
			digest,
			signal,
		}));
	}
	override enqueue(_sessionId: string, record: object): boolean {
		let epochSignal: SharedArrayBuffer | undefined;
		// Built under the host's payload permit (S12b): no line, snapshot or transcript exists before it is held.
		transfer((signal) => {
			const line = legacyJsonText(record);
			if (Buffer.byteLength(line) > SESSION_WORKER_LIMITS.outputBytes) failWorker("session_worker_output_limit");
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
					? workerSnapshot(entry)
					: undefined;
			if (replacement && Buffer.byteLength(JSON.stringify(replacement)) > SESSION_WORKER_LIMITS.outputBytes)
				failWorker("session_worker_snapshot_limit");
			const replaced = "type" in record && record.type === "session_replaced";
			const issued = this.connectionContext.owner?.wire;
			const owner = issued && { ownerId: issued.ownerId, bindingGeneration: issued.bindingGeneration };
			if (ordered && replaced) {
				journaled = session.sessionManager;
				stamp.forget();
				canonicalLost = false;
			}
			const transitions = ordered && !replaced ? (journaled?.drainTranscript() ?? []) : [];
			epochSignal = ordered && replaced ? new SharedArrayBuffer(36) : undefined;
			const recovery = recoveryCarrier(record);
			const canonical = carriedCanonical(record);
			const order = ordered
				? {
						...stamp.stamp(recovery, canonical, record),
						recovery,
						...(canonical ? { canonical } : {}),
						...(carriedRefusal(record) ? { canonicalRefused: true as const } : {}),
						...(replaced
							? {
									bootstrap: {
										transcript: withinFrameLimit(session.sessionManager.beginTranscriptJournal()),
										epochSignal,
									},
								}
							: {}),
						...(transitions.length > 0 ? { transitions: withinFrameLimit(transitions) } : {}),
					}
				: {};
			return {
				...order,
				type: "output",
				admissionReply: captureAdmissionReply(),
				// Keep one JSON-normal transfer format, including toJSON and non-cloneable fields; with the flag ON a record
				// over one fragment then travels as bounded fragments of this message's JSON (S12b).
				...(jsonTextDeeperThan(line, COMPACT_PROTOCOL_MAX_DEPTH)
					? { record: {}, recordText: line }
					: { record: JSON.parse(line) as object }),
				connection: this.currentConnection(),
				...(owner === undefined ? {} : { owner }),
				signal,
				activity,
				snapshot: replacement,
			};
		});
		if (epochSignal && entry?.runtime)
			setSessionRecoveryEpoch(entry.runtime.session, Buffer.from(epochSignal).toString("ascii"));
		return true;
	}
	override enqueueCanonical(_sessionId: string, control: CanonicalControl): void {
		if (!ordered) return;
		const { ordinal, firstOrdinal = ordinal } = stamp.stamp(control.carrier, control.record);
		const { record, carrier: recovery } = control;
		transfer((signal) => ({ type: "canonical", ordinal, firstOrdinal, recovery, record, signal }));
	}
	override canonicalUnavailable(_sessionId: string, cause: unknown): void {
		// The host's compact state for this epoch is already gone after the first real loss; later losses would only cost
		// exchanges. A depth refusal is never that loss and is always sent: the host counts it, live state or not (RULING-59 C).
		const limit = protocolDepthLimitOf(cause);
		if (!ordered || (canonicalLost && limit === undefined)) return;
		canonicalLost ||= limit === undefined;
		const { ordinal } = stamp.stamp(undefined, undefined);
		const reason = cause instanceof Error ? cause.message : String(cause);
		transfer((signal) => ({ type: "canonical_unavailable", ordinal, reason, limit, signal }));
	}
}

const writer = new WorkerEventWriter();
const issuedOwners = new IssuedWorkerOwners();
// One session per isolate: the roles of the connections it serves, adopted from the host before each command.
const connectionRoles = new ConnectionRoles();
let prepared: Extract<HostToSessionWorker, { type: "prepare" }> | undefined;
let registry: RpcSessionRegistry | undefined;
let entry: RpcSessionEntry | undefined;
let binding: RpcSessionBinding | undefined;
let closing = false;
/** Set by `commit` when the host owns an acceptance lane; each output frame then carries the next ordinal. */
let ordered = false;
/** The output-frame ordinal (S04a) is the compact producer ordinal: one numbering (RULING-36). */
const stamp = new CompactProducerStamp();
/** One `canonical_unavailable` frame per epoch: set by the first, cleared with `stamp.forget()` at a replacement. */
let canonicalLost = false;
/** The manager whose committed transcript changes ride the next output frame; replaced with the session. */
let journaled: SessionManager | undefined;
let unsubscribe: (() => void) | undefined;
let unsubscribeWake: (() => void) | undefined;

function publishSnapshot(settled = false): void {
	transfer((signal) => {
		const value = workerSnapshot(entry);
		if (Buffer.byteLength(JSON.stringify(value)) > SESSION_WORKER_LIMITS.outputBytes)
			failWorker("session_worker_snapshot_limit");
		return { type: "snapshot", snapshot: value, signal, settled };
	});
}

function subscribeSession(): void {
	unsubscribe?.();
	unsubscribeWake?.();
	unsubscribeWake = entry?.runtime?.session.extensionRunner.onBusEvent(WAKE_SOURCE_STATE_EVENT, () =>
		publishSnapshot(),
	);
	// Settled for the host's drain only at agent_idle: agent_settled can precede its extension handlers (omo#11419).
	unsubscribe = entry?.runtime?.session.subscribe((event) => publishSnapshot(event.type === "agent_idle"));
}

async function handle(message: HostToSessionWorker): Promise<void> {
	switch (message.type) {
		case "prepare": {
			if (prepared) throw new Error("Session worker already prepared");
			for (const limits of message.subscriptionLimits) subscriptionLimits.adopt(limits);
			// Resolved here, not on the host loop, which never inspects caller paths (senpi#2898).
			const profile = resolveMovedProfile(message.profile);
			const path =
				profile.sessionPath ??
				join(
					getDefaultSessionDir(profile.cwd, message.configuration.agentDir),
					`${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`,
				);
			prepared = { ...message, profile: { ...profile, sessionPath: canonicalSessionPath(path) } };
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
			registry = createSessionWorkerRegistry(prepared.configuration.agentDir, factory);
			const opened = await registry.openSession(prepared.profile);
			entry = registry.getForCommand(opened.sessionId, "open_session");
			// A legacy-only session (flag off, no structured lane) declines the offer: `ready` without a bootstrap.
			ordered =
				message.acceptance === true && entry.runtime !== undefined && structuredLaneEnabled(entry.runtime.session);
			if (message.recoveryEpoch && entry.runtime)
				setSessionRecoveryEpoch(entry.runtime.session, message.recoveryEpoch);
			journaled = ordered ? entry.runtime?.session.sessionManager : undefined;
			if (ordered && message.permits) installTransport(new WorkerTransfer(send, message.permits, stamp, failWorker));
			// The bootstrap answer is built only once the initial permit is held (S12b X03).
			post(() => ({
				type: "ready",
				request: message.request,
				snapshot: workerSnapshot(entry),
				...(ordered
					? { bootstrap: { transcript: withinFrameLimit(journaled?.beginTranscriptJournal() ?? []) } }
					: {}),
			}));
			return;
		}
		case "bind": {
			if (!entry || binding) throw new Error("Invalid session binding");
			if (message.roles !== undefined) connectionRoles.adopt(roleConnection(message.connection), message.roles);
			const bindingEntry = entry;
			privateFormsEnforced = message.mcpFormsEnforced === true;
			const createBinding = () =>
				createRpcSessionBinding(message.sessionId, bindingEntry, writer, () => send({ type: "request_close" }), {
					capabilities: message.capabilities,
					connectionRoles,
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
		case "cancel_grant": {
			await binding?.handle({ type: "extension_ui_response", id: message.id, cancelled: true });
			return;
		}
		case "cancel_secret":
			writer.secretCancels.get(message.id)?.();
			return;
		case "command": {
			const privileged =
				"type" in message.command &&
				["abort", "abort_bash", "extension_ui_response", "extension_ui_progress"].includes(
					String(message.command.type),
				);
			if (!binding || (closing && !privileged)) throw new Error("session_closing");
			if (message.roles !== undefined) connectionRoles.adopt(roleConnection(message.connection), message.roles);
			const activeBinding = binding;
			const run = () => activeBinding.handle(message.command);
			await workerAdmissionCommand(message, writer, issuedOwners, run);
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
		case "subscription_limits":
			for (const limits of message.accounts) subscriptionLimits.adopt(limits);
			return;
		case "owners_retired":
			issuedOwners.retire(message.owners);
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
			connectionRoles.clear();
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

// A turn in this isolate reports into its own store; the host mirrors it so its clients see it (senpi#3695).
subscriptionLimits.subscribeMirror((limits) => send({ type: "subscription_limits", limits }));

port.on("message", (message: HostToSessionWorker) => {
	if (privateForms.receive(message)) return;
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
