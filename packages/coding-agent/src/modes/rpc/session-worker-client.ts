import type { BrowserEngine } from "../../core/browser-engine.ts";
import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";
import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { StructuredLaneUnavailableError } from "../../core/structured-session-lane.ts";
import { isSecurityNoticeState } from "../../core/security-notices.ts";
import { createWebViewBroker } from "../../core/webview/webview-broker.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import type { RpcConnectionOptions } from "./connection-handler.ts";
import { workerCapabilities } from "./worker-client-capabilities.ts";
import { captureAdmissionReply, withAdmissionReply } from "./compact-admission-reply.ts";
import { roleConnection } from "./connection-roles.ts";
import { answeredUiRequestId, isGrantSelectRequest, refusedExtensionUiResponse } from "./extension-ui-response.ts";
import { enqueueLegacyRecord } from "./legacy-record-depth.ts";
import type { SecretInputRoute } from "./secret-input-requests.ts";
import type { RpcSessionBinding } from "./session-binding.ts";
import type { RpcExtensionUIResponse } from "./rpc-types.ts";
import { SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import { frameUnit } from "./compact-canonical-pairing.ts";
import { canonicalLoss } from "./compact-protocol-depth.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { RpcSessionLaunchProfile } from "./session-registry.ts";
import type { HostToSessionWorker, SessionWorkerToHost, WorkerSnapshot } from "./session-worker-protocol.ts";
import { subscriptionLimits } from "../../core/subscription-limits/limit-store.ts";
import { SessionWorkerRequests, type WorkerRequestInput } from "./session-worker-requests.ts";
import { WorkerIntake } from "./session-worker-intake.ts";
import { acknowledge, acknowledgeGrant } from "./session-worker-signals.ts";
import { WorkerOwnerGates } from "./session-worker-owners.ts";
import { WorkerSecretIds } from "./session-worker-secrets.ts";
import { randomUUID } from "node:crypto";
import type { McpFormBinding } from "../../core/mcp-form-types.ts";
import { recoveryAgentDir } from "./compact-storage-health.ts";
import type { SessionWorkerCallbacks } from "./session-worker-callbacks.ts";
import { startSessionWorker } from "./session-worker-start.ts";
import { reconcileWorkerReplacement } from "./session-worker-replacement.ts";

export class SessionWorkerClient {
	private secretRoute?: SecretInputRoute;
	private readonly secretIds = new WorkerSecretIds();
	private privateBinding?: McpFormBinding;
	private stopPrivateBinding?: () => void;
	private readonly privateOperations = new Map<
		string,
		{ operation: AbortController; presentation: AbortController; epoch: string }
	>();
	/** The worker's own route to the main-thread Bun.WebView service; released when the worker exits. */
	private readonly webviewBroker = createWebViewBroker();
	private readonly spawned: ReturnType<typeof startSessionWorker>;
	readonly worker: ReturnType<typeof startSessionWorker>["result"];
	readonly exited: Promise<void>;
	snapshot?: WorkerSnapshot;
	/** Main marks this only after installing the unique routing binding. */
	bindingReady = false;
	private readonly request = (message: WorkerRequestInput) => this.requests.request(message);
	private readonly requests = new SessionWorkerRequests(
		(message) => this.worker.postMessage(message),
		() => this.fail("session_worker_request_timeout"),
	);
	private stopped = false;
	private closeTimer?: ReturnType<typeof setTimeout>;
	private writer?: SessionEventWriter;
	private sessionId?: string;
	private requestClose?: () => void;
	private options: Pick<RpcConnectionOptions, "capabilities" | "clientInfo" | "connectionRoles"> = {};
	private readonly listeners = new Set<() => void>();
	private cancelUiPending = false;
	private terminalFailure?: string;
	private stopLimitMirror: () => void = () => {};
	/** The host's ordered acceptance lane for this worker incarnation, present only once `commit()` negotiated it. */
	acceptance: SessionAcceptanceLane | undefined;
	/** The host half of the negotiated payload transport: permits, physical frame order, fragment staging (S12b). */
	intake: WorkerIntake | undefined;
	private readonly owners = new WorkerOwnerGates();

	private readonly callbacks: SessionWorkerCallbacks;
	private readonly agentDir: string;

	constructor(callbacks: SessionWorkerCallbacks, agentDir = recoveryAgentDir) {
		this.callbacks = callbacks;
		this.agentDir = agentDir;
		// Spawned here, with nothing between it and the exit listener that owns its cleanup (senpi#4728).
		this.spawned = startSessionWorker(this.webviewBroker);
		this.worker = this.spawned.result;
		this.exited = new Promise((resolve, reject) => {
			this.worker.once("exit", () => {
				this.intake?.permits.close();
				for (const id of this.secretIds.ids()) this.secretRoute?.forget(id);
				this.secretIds.clear();
				this.stopPrivateBinding?.();
				this.privateBinding?.dispose();
				this.owners.retireAll();
				this.spawned.issued.dispose();
				for (const operation of this.privateOperations.values()) operation.operation.abort();
				this.privateOperations.clear();
				if (!this.stopped && !this.closeTimer) this.fail("session_worker_exited");
				this.stopped = true;
				if (this.closeTimer) clearTimeout(this.closeTimer);
				this.requests.close(new Error("session_worker_exited"));
				void this.webviewBroker?.dispose();
				this.stopLimitMirror();
				this.listeners.clear();
				const released = callbacks.exit();
				if (released)
					void released.then(() => {
						this.publishTerminalFailure();
						resolve();
					}, reject);
				else {
					this.publishTerminalFailure();
					resolve();
				}
			});
		});
		this.worker.on("message", (message: SessionWorkerToHost) => this.receive(message));
		this.worker.on("error", (error: unknown) => this.fail(error instanceof Error ? error.message : String(error)));
	}

	async prepare(configuration: CliRuntimeConfiguration, profile: RpcSessionLaunchProfile): Promise<string> {
		// The host's poller feeds only the host's store and the isolate reads its own copy, so the isolate starts
		// from the host's records and then receives each change (senpi#3695). Subscribing before the request is
		// posted keeps a change that lands in between ordered after the snapshot.
		this.stopLimitMirror();
		this.stopLimitMirror = subscriptionLimits.subscribeMirror((limits) =>
			this.post({ type: "subscription_limits", accounts: [limits] }),
		);
		const result = await this.request({
			type: "prepare",
			configuration,
			profile,
			subscriptionLimits: subscriptionLimits.mirrorSnapshot(),
		});
		if (result.type !== "prepared") throw new Error("Invalid worker prepare response");
		return result.sessionPath;
	}

	/** Moves the worker's live session to another prompt surface (a later `open_session.promptSurface`). */
	async setPromptSurface(surface: PromptSurface): Promise<void> {
		const result = await this.request({ type: "prompt_surface", surface });
		if (result.type !== "result") throw new Error("Invalid worker prompt_surface response");
	}

	/** Moves the worker's live session to another browser engine (a later `open_session.browserEngine`). */
	async setBrowserEngine(engine: BrowserEngine): Promise<void> {
		const result = await this.request({ type: "browser_engine", engine });
		if (result.type !== "result") throw new Error("Invalid worker browser_engine response");
	}

	/** Moves the worker's live session to another permission preset (a later `open_session.permissionPreset`). */
	async setPermissionPreset(preset: string): Promise<void> {
		const result = await this.request({ type: "permission_preset", preset });
		if (result.type !== "result") throw new Error("Invalid worker permission_preset response");
	}

	async commit(): Promise<WorkerSnapshot> {
		if (!compactUpdatesEnabled()) {
			// Flag off: a plain commit with no acceptance lane and no permit transport, as before S17 (RULING-112).
			const result = await this.request({ type: "commit" });
			if (result.type !== "ready") throw new Error("Invalid worker commit response");
			this.snapshot = result.snapshot;
			return result.snapshot;
		}
		const nonce = randomUUID();
		// Offered here, never earlier: until commit the incarnation holds no permit and its frames are unordered. The offer
		// needs both halves up front, since a bootstrap `ready` is permit-paid and may arrive as staged fragments.
		const acceptance = new SessionAcceptanceLane(undefined, undefined, this.agentDir);
		const intake = new WorkerIntake(acceptance.staging, (error) => this.fail(error));
		this.acceptance = acceptance;
		this.intake = intake;
		let negotiated = false;
		try {
			const result = await this.request({
				type: "commit",
				acceptance: true,
				recoveryEpoch: nonce,
				permits: intake.permits.block,
			});
			if (result.type !== "ready") throw new Error("Invalid worker commit response");
			// RULING-106: a worker that cannot bootstrap acceptance has no structured lane to offer.
			if (!result.bootstrap) throw new StructuredLaneUnavailableError();
			// Accepted before the open resolves, so the entry is admitted only after its baseline (R3.C1.1).
			acceptance.bootstrap(result.bootstrap, nonce);
			negotiated = true;
			this.snapshot = result.snapshot;
			return result.snapshot;
		} finally {
			// A refused or failed commit withdraws the offer, leaving no lane and no permit behind.
			if (!negotiated) {
				intake.permits.close();
				acceptance.retire("close");
				this.acceptance = this.intake = undefined;
			}
		}
	}

	async bind(
		sessionId: string,
		writer: SessionEventWriter,
		requestClose: () => void,
		options: Pick<RpcConnectionOptions, "capabilities" | "clientInfo" | "connectionRoles">,
	): Promise<RpcSessionBinding> {
		this.sessionId = sessionId;
		this.writer = writer;
		this.secretRoute = writer.secretInputRoute(sessionId);
		if (this.acceptance) writer.registerAcceptance(sessionId, this.acceptance);
		// RULING-111 (LEAK-D): a diagnostic of the compact path; with the flag off the stderr stays as on main.
		if (compactUpdatesEnabled())
			process.stderr.write(
				`senpi rpc worker ${sessionId}: bound mode=${this.acceptance ? "acceptance" : "legacy"}\n`,
			);
		this.requestClose = requestClose;
		this.options = options;
		await this.request({
			type: "bind",
			sessionId,
			capabilities: options.capabilities ?? [],
			connection: writer.currentConnection(),
			roles: options.connectionRoles?.rolesOf(roleConnection(writer.currentConnection())),
			mcpFormsEnforced: writer.mcpPresenters !== undefined,
		});
		return {
			handle: async (command) => {
				if (writer.handleMcpForm(command)) return;
				const connection = writer.currentConnection();
				const owner = this.owners.capture(writer.connectionContext, connection, command);
				// The grant rules apply to the request this response answers (`uiRequestId`, or `id` in the
				// short form), the same request the worker settles.
				const answered =
					"type" in command && command.type === "extension_ui_response"
						? answeredUiRequestId(command as RpcExtensionUIResponse)
						: undefined;
				if (answered !== undefined && writer.acceptWorkerGrantResponse(sessionId, answered, connection) === false)
					return;
				if (answered !== undefined && this.secretIds.has(answered) && !this.secretRoute?.accepts(answered)) {
					const response = command as RpcExtensionUIResponse;
					writer.enqueue(sessionId, refusedExtensionUiResponse(response.id, "secret_answer_refused"));
					return;
				}
				await this.request({
					type: "command",
					admissionReply: captureAdmissionReply(),
					command,
					connection,
					roles: options.connectionRoles?.rolesOf(roleConnection(connection)),
					...(owner === undefined ? {} : { owner }),
				});
			},
			cancelPendingExtensionUiRequests: () => this.post({ type: "cancel_ui" }),
			connectionDetached: (connection) => this.postRetired(this.owners.detach(writer.connectionContext, connection)),
			dispose: async () => {
				this.postRetired(this.owners.retireAll());
				this.post({ type: "cancel_ui" });
			},
		};
	}

	get busy(): boolean {
		return this.requests.activeCount > 0 || this.snapshot?.busy === true;
	}

	get handoffBusy(): boolean {
		return this.requests.activeCount > 0 || (this.snapshot?.handoffBusy ?? this.snapshot?.busy) === true;
	}

	subscribeSettled(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Deadline requests termination, but only the actual exit callback releases ownership. */
	close(graceMs: number): Promise<void> {
		if (this.stopped || this.closeTimer) return this.exited;
		this.post({ type: "close" });
		this.closeTimer = setTimeout(() => this.quarantine(), graceMs);
		return this.exited;
	}

	quarantine(): void {
		this.intake?.permits.close();
		this.stopped = true;
		this.requests.close(new Error("session_closing"));
		void this.worker.terminate();
	}

	private postRetired(owners: ReturnType<WorkerOwnerGates["retireAll"]>): void {
		if (owners.length > 0) this.post({ type: "owners_retired", owners });
	}

	private post(message: HostToSessionWorker): void {
		if (this.stopped) return;
		if (message.type === "cancel_ui") {
			if (this.cancelUiPending) return;
			this.cancelUiPending = true;
		}
		this.worker.postMessage(message);
	}

	private receive(message: SessionWorkerToHost): void {
		if (this.stopped) {
			if ("signal" in message && message.signal) acknowledge(message.signal, false);
			return;
		}
		this.intake?.received(message);
		switch (message.type) {
			case "secret_select": {
				if (!this.secretIds.has(message.id) && !this.secretIds.admitsNew()) {
					acknowledge(message.signal, false);
					return;
				}
				const select = () => {
					const reason =
						this.secretRoute?.select(message.id, () => this.post({ type: "cancel_secret", id: message.id })) ??
						(this.secretRoute ? undefined : "no_presenter");
					if (reason === undefined) this.secretIds.add(message.id);
					const result =
						reason === undefined
							? { accepted: true, connection: this.secretRoute?.presenter(message.id) }
							: { accepted: false, reason };
					const encoded = new TextEncoder().encode(JSON.stringify(result));
					new Uint8Array(message.decision, 4).set(encoded);
					Atomics.store(new Int32Array(message.decision, 0, 1), 0, encoded.length);
					acknowledge(message.signal, true);
				};
				if (message.connection !== undefined && this.writer) this.writer.withConnection(message.connection, select);
				else select();
				return;
			}
			case "secret_frame":
				if (!this.secretIds.admitFrame(message.id, message.record)) {
					acknowledge(message.signal, false);
					return;
				}
				this.secretRoute?.send(message.id, message.record);
				acknowledge(message.signal, true);
				return;
			case "secret_settled":
				this.secretRoute?.settled(message.id);
				acknowledge(message.signal, true);
				return;
			case "secret_forget":
				this.secretIds.forget(message.id);
				this.secretRoute?.forget(message.id);
				acknowledge(message.signal, true);
				return;
			case "secret_handshake":
				this.writer?.setSoleSecretCapabilities(message.capabilities);
				acknowledge(message.signal, true);
				return;
			case "mcp_form_bind": {
				this.stopPrivateBinding?.();
				this.privateBinding?.dispose();
				const writer = this.writer;
				const sessionId = this.sessionId;
				if (!writer?.mcpPresenters || !sessionId) {
					this.fail("private_form_unavailable");
					return;
				}
				const bound = writer.bindMcpForms(sessionId, message.durableId, {}, () => {});
				if (bound instanceof Promise) {
					this.fail("private_form_unavailable");
					return;
				}
				this.privateBinding = writer.getMcpFormBinding(sessionId);
				const binding = this.privateBinding;
				if (!binding) {
					this.fail("private_form_unavailable");
					return;
				}
				const unsubscribe = binding.subscribe?.(() =>
					this.post({
						type: "mcp_form_availability",
						epoch: binding.epoch,
						version: binding.version?.(),
					}),
				);
				this.stopPrivateBinding = () => {
					unsubscribe?.();
					bound?.();
				};
				this.post({ type: "mcp_form_bound", id: message.id, epoch: binding.epoch, version: binding.version?.() });
				return;
			}
			case "mcp_form_ready": {
				const binding = this.privateBinding;
				this.post({
					type: "mcp_form_availability",
					id: message.id,
					epoch: message.epoch,
					version: binding?.epoch === message.epoch ? binding.version?.() : undefined,
				});
				return;
			}
			case "mcp_form_release":
				if (this.privateBinding?.epoch === message.epoch) this.stopPrivateBinding?.();
				return;
			case "mcp_form_cancel": {
				const operation = this.privateOperations.get(message.id);
				if (operation?.epoch === message.epoch) operation[message.lifetime].abort();
				return;
			}
			case "mcp_form_create": {
				const binding = this.privateBinding;
				const presenter =
					binding?.epoch === message.epoch && binding.version?.() === message.version
						? binding.capture()
						: undefined;
				const operation = new AbortController();
				const presentation = new AbortController();
				this.privateOperations.set(message.id, { operation, presentation, epoch: message.epoch });
				const fence = new Int32Array(message.operationFence);
				const result = presenter?.present({
					...message.input,
					operationSignal: operation.signal,
					presentationSignal: presentation.signal,
					operationCurrent: () => Atomics.load(fence, 0) === 0,
				});
				void Promise.resolve(result).then((outcome) => {
					this.privateOperations.delete(message.id);
					this.post({
						type: "mcp_form_settlement",
						id: message.id,
						epoch: message.epoch,
						settlementId: randomUUID(),
						outcome: outcome ?? { kind: "processing_failure", source: "host_termination", humanAdmission: false },
					});
				});
				return;
			}
			case "prepared":
			case "ready":
			case "result": {
				this.requests.receive(message);
				if (this.snapshot)
					void Promise.resolve(this.callbacks.reconcile(this.snapshot.liveSessionPaths)).catch(() =>
						this.fail("session_claim_reconcile_failed"),
					);
				return;
			}
			case "reserve":
				void Promise.resolve(this.callbacks.reserve(message.path)).then(
					(grant) => acknowledgeGrant(message.signal, this.stopped ? "conflict" : grant),
					() => acknowledgeGrant(message.signal, "conflict"),
				);
				return;
			case "snapshot":
				this.snapshot = message.snapshot;
				void Promise.resolve(this.callbacks.reconcile(message.snapshot.liveSessionPaths)).then(
					() => {
						acknowledge(message.signal, !this.stopped);
						if (message.settled) for (const listener of [...this.listeners]) listener();
					},
					() => {
						acknowledge(message.signal, false);
						this.fail("session_claim_reconcile_failed");
					},
				);
				return;
			case "control_done":
				this.cancelUiPending = false;
				return;
			case "output": {
				const writer = this.writer;
				const sessionId = this.sessionId;
				if (!writer || !sessionId || this.stopped) {
					acknowledge(message.signal, false);
					return;
				}
				const lane = this.acceptance;
				if (this.intake?.inOrder(message) === false) return;
				// Identity and activity commit before publication; clients may attach or disconnect on that event.
				if (message.snapshot) this.snapshot = message.snapshot;
				else if (this.snapshot)
					this.snapshot = {
						...this.snapshot,
						...message.activity,
						state: { ...this.snapshot.state, isStreaming: message.activity.streaming },
					};
				const record: object = message.recordText === undefined ? message.record : JSON.parse(message.recordText);
				if (
					"type" in record &&
					record.type === "security_grant_settled" &&
					"id" in record &&
					typeof record.id === "string"
				) {
					writer.settleGrantDialog(sessionId, record.id);
					acknowledge(message.signal, true);
					return;
				}
				if ("type" in record && record.type === "security_notice_snapshot") {
					if (!("snapshot" in record) || !isSecurityNoticeState(record.snapshot)) {
						acknowledge(message.signal, false);
						this.fail("invalid_security_notice_snapshot");
						return;
					}
					writer.acceptWorkerSecuritySnapshot(sessionId, record.snapshot);
					acknowledge(message.signal, true);
					return;
				}
				let outputConnection = message.connection;
				if (isGrantSelectRequest(record)) {
					const target = writer.routeWorkerGrant(
						sessionId,
						record.id,
						message.connection,
						this.options.capabilities ?? [],
						() => this.post({ type: "cancel_grant", id: record.id }),
					);
					if (!target.accepted) {
						acknowledge(message.signal, true);
						return;
					}
					outputConnection = target.connection;
				}
				const enqueue = () =>
					withAdmissionReply(message.admissionReply, () => {
						// Applied before routing, and so before this frame's credit returns.
						if (message.bootstrap) lane?.bootstrap(message.bootstrap);
						else {
							lane?.applyTranscript(message.transitions ?? []);
							lane?.accept(record, message.recovery, frameUnit(message), message.canonicalRefused === true);
						}
						if (!enqueueLegacyRecord(writer, sessionId, record)) {
							acknowledge(message.signal, false);
							this.fail("session_output_overflow_or_closed");
							return Promise.reject(new Error("session_output_overflow_or_closed"));
						}
						return writer.waitForSessionBackpressure(sessionId);
					});
				const consumed = reconcileWorkerReplacement(message, lane, this.callbacks).then(() => {
					// Resolved after reconciliation: a retired or replaced destination consumes the frame normally.
					if (outputConnection === undefined) return enqueue();
					return message.owner === undefined || outputConnection !== message.connection
						? writer.withConnection(outputConnection, enqueue)
						: writer.connectionContext.runCaptured(outputConnection, message.owner, enqueue);
				});
				void consumed.then(
					() => acknowledge(message.signal, true),
					(cause: unknown) => {
						acknowledge(message.signal, false);
						this.fail(cause instanceof Error ? cause.message : String(cause));
					},
				);
				return;
			}
			case "canonical":
			case "canonical_unavailable":
				// Credited under the same condition as an output frame: only a bound, running incarnation accepts units.
				if (!this.writer || !this.sessionId || this.stopped) {
					acknowledge(message.signal, false);
					return;
				}
				if (this.intake?.inOrder(message) === false) return;
				if (message.type === "canonical")
					this.acceptance?.acceptControl(frameUnit({ ...message, canonical: message.record }));
				else this.acceptance?.compactUnavailable(canonicalLoss(message));
				acknowledge(message.signal, true);
				return;
			case "capabilities":
				this.options = workerCapabilities(this.options, message, this.writer);
				return;
			case "loaded_surfaces": {
				// The host owns the per-(connection, session) dedupe on both runtimes (#3198 review, L5).
				const writer = this.writer;
				const sessionId = this.sessionId;
				if (!writer || !sessionId || this.stopped) {
					acknowledge(message.signal, false);
					return;
				}
				writer.publishLoadedSurfacesChanged(sessionId, message.previous, message.digest);
				acknowledge(message.signal, true);
				return;
			}
			case "fragment":
				void this.intake?.fragment(message)?.then(
					(whole) => this.receive(whole),
					() => this.fail("session_worker_transfer_unreadable"),
				);
				return;
			case "request_close":
				this.requestClose?.();
				return;
			case "subscription_limits":
				subscriptionLimits.adopt(message.limits);
				return;
			case "failure":
				this.fail(message.error);
				return;
		}
	}

	private fail(error: string): void {
		if (this.stopped) return;
		this.acceptance?.retire("worker_failed");
		this.callbacks.failure(error);
		this.terminalFailure = error;
		if (this.writer && this.sessionId) {
			this.writer.enqueue(this.sessionId, { type: "session_error", error });
		}
		this.quarantine();
	}

	/** Terminal close records observe completed registry removal, including worker failure. */
	private publishTerminalFailure(): void {
		const error = this.terminalFailure;
		const writer = this.writer;
		const sessionId = this.sessionId;
		if (error === undefined || !writer || !sessionId) return;
		this.terminalFailure = undefined;
		writer.closeSession(
			sessionId,
			{
				type: "response",
				command: "close_session",
				success: false,
				error,
			},
			"error",
		);
	}
}
