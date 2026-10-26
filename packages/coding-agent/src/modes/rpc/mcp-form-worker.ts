import { randomUUID } from "node:crypto";
import { bindPrivateMcpForms, type McpFormBinding, type McpFormOutcome } from "../../core/mcp-form-types.ts";
import type { HostToSessionWorker, SessionWorkerToHost } from "./session-worker-protocol.ts";

/** Private worker messages never pass through WorkerEventWriter.enqueue or a snapshot. */
export class McpFormWorker {
	private readonly send: (message: SessionWorkerToHost) => void;
	private readonly binds = new Map<
		string,
		(message: Extract<HostToSessionWorker, { type: "mcp_form_bound" }>) => void
	>();
	private readonly ready = new Map<string, () => void>();
	private readonly settlements = new Set<string>();
	private readonly bindings = new Map<
		string,
		{ version?: string; active: boolean; admit: () => void; listeners: Set<() => void> }
	>();
	private readonly entries = new Map<
		string,
		{
			readonly epoch: string;
			readonly resolve: (outcome: McpFormOutcome) => void;
			readonly cleanup: () => void;
			readonly fence: Int32Array;
		}
	>();

	constructor(send: (message: SessionWorkerToHost) => void) {
		this.send = send;
	}

	async bind(durableId: string, ui: object, admit: () => void): Promise<() => void> {
		const id = randomUUID();
		const bound = Promise.withResolvers<Extract<HostToSessionWorker, { type: "mcp_form_bound" }>>();
		this.binds.set(id, bound.resolve);
		const timer = setTimeout(() => bound.reject(new Error("private_form_unavailable")), 5_000);
		timer.unref();
		let message: Extract<HostToSessionWorker, { type: "mcp_form_bound" }>;
		try {
			this.send({ type: "mcp_form_bind", id, durableId });
			message = await bound.promise;
		} finally {
			clearTimeout(timer);
			this.binds.delete(id);
		}
		const lifetime = new AbortController();
		const state = { version: message.version, active: true, admit, listeners: new Set<() => void>() };
		this.bindings.set(message.epoch, state);
		const binding: McpFormBinding = {
			epoch: message.epoch,
			signal: lifetime.signal,
			subscribe: (listener) => {
				state.listeners.add(listener);
				return () => {
					state.listeners.delete(listener);
				};
			},
			capture: () => {
				const version = state.version;
				if (!state.active || version === undefined) return undefined;
				return {
					signal: new AbortController().signal,
					ready: () => state.active && state.version === version,
					synchronize: () => {
						const request = randomUUID();
						const answer = new Promise<void>((resolve) => this.ready.set(request, resolve));
						this.send({ type: "mcp_form_ready", id: request, epoch: message.epoch });
						return answer;
					},
					present: (input) =>
						new Promise((resolve) => {
							const request = randomUUID();
							const operationFence = new SharedArrayBuffer(4);
							const fence = new Int32Array(operationFence);
							const cancelOperation = () => {
								Atomics.store(fence, 0, 1);
								this.send({
									type: "mcp_form_cancel",
									id: request,
									epoch: message.epoch,
									lifetime: "operation",
								});
							};
							const cancelPresentation = () =>
								this.send({
									type: "mcp_form_cancel",
									id: request,
									epoch: message.epoch,
									lifetime: "presentation",
								});
							input.operationSignal.addEventListener("abort", cancelOperation, { once: true });
							input.presentationSignal.addEventListener("abort", cancelPresentation, { once: true });
							this.entries.set(request, {
								epoch: message.epoch,
								resolve,
								fence,
								cleanup: () => {
									input.operationSignal.removeEventListener("abort", cancelOperation);
									input.presentationSignal.removeEventListener("abort", cancelPresentation);
								},
							});
							const { operationSignal, presentationSignal, operationCurrent: _current, ...wire } = input;
							if (operationSignal.aborted) Atomics.store(fence, 0, 1);
							this.send({
								type: "mcp_form_create",
								id: request,
								epoch: message.epoch,
								version,
								operationFence,
								input: wire,
							});
							if (operationSignal.aborted) cancelOperation();
							if (presentationSignal.aborted) cancelPresentation();
						}),
				};
			},
			dispose: () => {
				lifetime.abort();
				state.active = false;
				for (const entry of this.entries.values())
					if (entry.epoch === message.epoch) Atomics.store(entry.fence, 0, 1);
				this.bindings.delete(message.epoch);
				state.listeners.clear();
				this.send({ type: "mcp_form_release", epoch: message.epoch });
			},
		};
		bindPrivateMcpForms(ui, binding);
		return binding.dispose;
	}

	receive(message: HostToSessionWorker): boolean {
		switch (message.type) {
			case "mcp_form_bound": {
				const resolve = this.binds.get(message.id);
				if (resolve) resolve(message);
				else this.send({ type: "mcp_form_release", epoch: message.epoch });
				this.binds.delete(message.id);
				return true;
			}
			case "mcp_form_availability": {
				const binding = this.bindings.get(message.epoch);
				if (binding && binding.version !== message.version) {
					binding.version = message.version;
					for (const listener of binding.listeners) listener();
				}
				if (message.id) {
					this.ready.get(message.id)?.();
					this.ready.delete(message.id);
				}
				return true;
			}
			case "mcp_form_settlement": {
				const entry = this.entries.get(message.id);
				if (!entry || entry.epoch !== message.epoch || this.settlements.has(message.settlementId)) return true;
				this.settlements.add(message.settlementId);
				if (this.settlements.size > 256) {
					const oldest = this.settlements.values().next().value;
					if (oldest !== undefined) this.settlements.delete(oldest);
				}
				this.entries.delete(message.id);
				entry.cleanup();
				const binding = this.bindings.get(message.epoch);
				if (!binding?.active) {
					entry.resolve({ kind: "operation_aborted", source: "host_termination", humanAdmission: false });
					return true;
				}
				// Host-only union provenance, never inferred from cancel/decline/accept alone.
				if (message.outcome.source === "presenter_action" && message.outcome.humanAdmission) binding.admit();
				entry.resolve(message.outcome);
				return true;
			}
			default:
				return false;
		}
	}
}
