import { randomUUID } from "node:crypto";
import { queuedForm } from "../../core/extensions/builtin/mcp/modern/consent-queue.ts";
import { isRecord, validateMrtrForm } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import type {
	McpFormBinding,
	McpFormInput,
	McpFormOutcome,
	McpFormPresentation,
	McpFormRequest,
	McpFormResolved,
	McpFormScope,
} from "../../core/mcp-form-types.ts";
import { McpFormDialog, mcpFormClock, type McpFormClock, type McpPresenterReply } from "./mcp-form-dialog.ts";

type Sender = (frame: McpFormRequest | McpFormResolved) => boolean;
export interface McpPresenterConnection {
	readonly id: string;
	readonly epoch: string;
	readonly nonce: string;
}
interface Connection extends McpPresenterConnection {
	readonly send: Sender;
	readonly attachments: Map<Binding, { readonly id: string; readonly epoch: string }>;
}
interface Binding extends McpFormBinding {
	readonly sessionId: string;
	readonly durableId: string;
	readonly lifetime: AbortController;
	readonly admit: () => void;
	readonly listeners: Set<() => void>;
	grant?: Grant;
}
export interface McpPresenterRegistration {
	readonly id: string;
}
interface Registration extends McpPresenterRegistration {
	readonly principal: string;
	readonly generation: string;
	readonly binding: Binding;
	readonly connection: Connection;
	readonly kind: McpFormScope["presenterKind"];
	active: boolean;
}
interface Grant {
	readonly id: string;
	readonly registration: Registration;
	readonly scope: McpFormScope;
	readonly lifetime: AbortController;
	readonly dialogs: Map<string, McpFormDialog>;
}

/** Host-owned only. No public session command can call enrollment or install a registration. */
export class McpPresenterAuthority {
	readonly instance = randomUUID();
	private readonly clock: McpFormClock;
	private readonly connections = new Map<McpPresenterConnection, Connection>();
	private readonly bindings = new Map<string, Binding>();
	private readonly registrations = new Map<McpPresenterRegistration, Registration>();

	constructor(options: { readonly clock?: McpFormClock } = {}) {
		this.clock = options.clock ?? mcpFormClock;
	}
	dispose(): void {
		for (const binding of [...this.bindings.values()]) binding.dispose();
		this.connections.clear();
		this.registrations.clear();
	}

	connect(id: string, send: Sender): McpPresenterConnection {
		const connection: Connection = { id, send, epoch: randomUUID(), nonce: randomUUID(), attachments: new Map() };
		this.connections.set(connection, connection);
		return connection;
	}

	attach(sender: McpPresenterConnection, handle: McpFormBinding): void {
		const connection = this.connections.get(sender);
		const binding = [...this.bindings.values()].find((value) => value === handle);
		if (connection && binding && !connection.attachments.has(binding))
			connection.attachments.set(binding, { id: randomUUID(), epoch: randomUUID() });
	}

	connectionContext(
		sender: McpPresenterConnection,
		sessionId: string,
	):
		| {
				hostInstance: string;
				connectionNonce: string;
				bindingEpoch: string;
				attachmentId: string;
				attachmentEpoch: string;
		  }
		| undefined {
		const connection = this.connections.get(sender);
		const binding = this.bindings.get(sessionId);
		const attachment = binding && connection?.attachments.get(binding);
		if (!connection || !binding || !attachment) return undefined;
		return {
			hostInstance: this.instance,
			connectionNonce: connection.nonce,
			bindingEpoch: binding.epoch,
			attachmentId: attachment.id,
			attachmentEpoch: attachment.epoch,
		};
	}

	detach(sender: McpPresenterConnection, handle?: McpFormBinding): void {
		const connection = this.connections.get(sender);
		if (!connection) return;
		for (const binding of connection.attachments.keys()) {
			if (handle !== undefined && handle !== binding) continue;
			connection.attachments.delete(binding);
			if (binding.grant?.registration.connection === connection) this.revoke(binding.grant.registration);
		}
		if (handle === undefined) this.connections.delete(sender);
	}
	withdraw(sender: McpPresenterConnection): void {
		const connection = this.connections.get(sender);
		if (!connection) return;
		for (const binding of connection.attachments.keys())
			if (binding.grant?.registration.connection === connection) this.revoke(binding.grant.registration);
	}

	bind(sessionId: string, durableId: string, admit: () => void): McpFormBinding {
		this.bindings.get(sessionId)?.dispose();
		const lifetime = new AbortController();
		const binding: Binding = {
			sessionId,
			durableId,
			admit,
			epoch: randomUUID(),
			lifetime,
			signal: lifetime.signal,
			listeners: new Set(),
			version: () => (binding.grant && this.current(binding.grant) ? binding.grant.id : undefined),
			subscribe: (listener) => {
				binding.listeners.add(listener);
				return () => {
					binding.listeners.delete(listener);
				};
			},
			capture: () => {
				const grant = binding.grant;
				return grant && this.current(grant) ? this.presentation(grant) : undefined;
			},
			dispose: () => {
				binding.lifetime.abort();
				if (binding.grant) this.revoke(binding.grant.registration, true);
				if (this.bindings.get(sessionId) === binding) this.bindings.delete(sessionId);
				for (const connection of this.connections.values()) connection.attachments.delete(binding);
				binding.listeners.clear();
			},
		};
		this.bindings.set(sessionId, binding);
		return binding;
	}

	/** Called only after the protected bootstrap has pinned and authenticated its launch principal. */
	enroll(principal: string = randomUUID()) {
		const generation = randomUUID();
		return {
			register: (
				handle: McpFormBinding,
				sender: McpPresenterConnection,
				options: { readonly kind: McpFormScope["presenterKind"] },
			): McpPresenterRegistration => {
				const binding = [...this.bindings.values()].find((value) => value === handle);
				const connection = this.connections.get(sender);
				if (!binding || binding.grant || !connection?.attachments.has(binding))
					throw new Error("presenter_not_authorized");
				const registration: Registration = {
					id: randomUUID(),
					principal,
					generation,
					binding,
					connection,
					kind: options.kind,
					active: true,
				};
				this.registrations.set(registration, registration);
				return registration;
			},
			acquire: (handle: McpPresenterRegistration): { readonly grantId: string; readonly scope: McpFormScope } => {
				const registration = this.registrations.get(handle);
				if (!registration || registration.principal !== principal || !registration.active)
					throw new Error("presenter_not_authorized");
				const { binding, connection } = registration;
				const attachment = connection.attachments.get(binding);
				if (!attachment || binding.lifetime.signal.aborted || binding.grant)
					throw new Error("presenter_not_authorized");
				const scope: McpFormScope = {
					hostInstance: this.instance,
					durableSessionId: binding.durableId,
					bindingEpoch: binding.epoch,
					attachmentId: attachment.id,
					attachmentEpoch: attachment.epoch,
					connectionId: connection.id,
					connectionEpoch: connection.epoch,
					presenterPrincipalId: principal,
					presenterGeneration: generation,
					presentationBindingId: registration.id,
					presenterKind: registration.kind,
					purpose: "mcp_form",
				};
				const grant: Grant = {
					id: randomUUID(),
					registration,
					scope,
					lifetime: new AbortController(),
					dialogs: new Map(),
				};
				binding.grant = grant;
				for (const listener of binding.listeners) listener();
				return { grantId: grant.id, scope };
			},
			revoke: (handle: McpPresenterRegistration): void => {
				const registration = this.registrations.get(handle);
				if (registration?.principal === principal) this.revoke(registration);
			},
		};
	}

	receive(sender: McpPresenterConnection, value: unknown): McpPresenterReply {
		const connection = this.connections.get(sender);
		const binding =
			isRecord(value) && typeof value.sessionId === "string" ? this.bindings.get(value.sessionId) : undefined;
		const grant = binding?.grant;
		// Check authority before parsing the private namespace, including invented dialog ids.
		if (!connection || !grant || grant.registration.connection !== connection || !this.current(grant))
			return { error: "presenter_not_authorized" };
		if (
			!isRecord(value) ||
			value.grantId !== grant.id ||
			value.bindingEpoch !== grant.scope.bindingEpoch ||
			value.attachmentEpoch !== grant.scope.attachmentEpoch
		)
			return { error: "presenter_not_authorized" };
		const allowed = [
			"type",
			"id",
			"sessionId",
			"bindingEpoch",
			"attachmentEpoch",
			"grantId",
			"dialogId",
			"dialogToken",
			"formRevision",
		];
		if (value.type === "mcp_form_response") allowed.push("action", "content");
		if (Object.keys(value).some((key) => !allowed.includes(key))) return { error: "invalid_form_response" };
		if (value.type === "mcp_form_sync") {
			const form = grant.dialogs.values().next().value?.sync();
			return form === undefined ? { ok: true } : { ok: true, form };
		}
		if (
			typeof value.dialogId !== "string" ||
			typeof value.dialogToken !== "string" ||
			typeof value.formRevision !== "string"
		)
			return { error: "invalid_form_response" };
		const dialog = grant.dialogs.get(value.dialogId);
		if (!dialog) return { error: "form_stale" };
		if (!dialog.matches(value.dialogToken, value.formRevision)) return { error: "invalid_form_response" };
		switch (value.type) {
			case "mcp_form_presented":
				return dialog.presented();
			case "mcp_form_response":
				return typeof value.action === "string"
					? dialog.respond(value.action, value.content)
					: { error: "invalid_form_response" };
			default:
				return { error: "invalid_form_response" };
		}
	}

	private current(grant: Grant): boolean {
		const { registration, scope } = grant;
		const { binding, connection } = registration;
		return (
			registration.active &&
			!binding.lifetime.signal.aborted &&
			!grant.lifetime.signal.aborted &&
			this.bindings.get(binding.sessionId) === binding &&
			binding.grant === grant &&
			this.connections.get(connection) === connection &&
			connection.attachments.get(binding)?.epoch === scope.attachmentEpoch
		);
	}

	private revoke(registration: Registration, operation = false): void {
		registration.active = false;
		this.registrations.delete(registration);
		const binding = registration.binding;
		const grant = binding.grant;
		if (!grant || grant.registration !== registration) return;
		binding.grant = undefined;
		for (const listener of binding.listeners) listener();
		// Retain entry references after authority is fenced. Cleanup never validates the revoked sender.
		for (const dialog of [...grant.dialogs.values()])
			dialog.terminate(operation ? "operation_aborted" : "presentation_lost");
		grant.lifetime.abort();
	}

	private presentation(grant: Grant): McpFormPresentation {
		return {
			signal: grant.lifetime.signal,
			ready: () => this.current(grant),
			present: (input) => this.present(grant, input),
		};
	}

	private present(grant: Grant, input: McpFormInput): Promise<McpFormOutcome> {
		const unavailable: McpFormOutcome = {
			kind: "processing_failure",
			source: "host_termination",
			humanAdmission: false,
		};
		if (
			!this.current(grant) ||
			!validateMrtrForm(input.schema) ||
			Object.keys(input.schema.properties).length > 64 ||
			Buffer.byteLength(JSON.stringify({ message: input.message, schema: input.schema })) > 512 * 1024
		)
			return Promise.resolve(unavailable);
		const binding = grant.registration.binding;
		const deadline = this.clock.now() + input.deadlineMs;
		const expired = new AbortController();
		const timer = this.clock.schedule(() => expired.abort(), Math.max(0, input.deadlineMs));
		const signal = AbortSignal.any([
			input.operationSignal,
			input.presentationSignal,
			grant.lifetime.signal,
			expired.signal,
		]);
		return queuedForm(grant, signal, () => {
			this.clock.cancel(timer);
			if (!this.current(grant)) return Promise.resolve(unavailable);
			const dialogId = randomUUID();
			const dialog = new McpFormDialog(
				{
					...input,
					presentationSignal: signal,
					deadlineMs: Math.max(0, deadline - this.clock.now()),
				},
				{
					clock: this.clock,
					envelope: {
						sessionId: binding.sessionId,
						bindingEpoch: binding.epoch,
						attachmentEpoch: grant.scope.attachmentEpoch,
						grantId: grant.id,
						dialogId,
						formRevision: randomUUID(),
					},
					current: () => this.current(grant),
					remove: () => {
						grant.dialogs.delete(dialogId);
					},
					admit: binding.admit,
					send: grant.registration.connection.send,
				},
			);
			grant.dialogs.set(dialogId, dialog);
			dialog.start();
			return dialog.result;
		})
			.catch((): McpFormOutcome => ({
				...unavailable,
				kind:
					input.operationSignal.aborted || binding.signal.aborted || input.operationCurrent?.() === false
						? "operation_aborted"
						: "processing_failure",
			}))
			.finally(() => this.clock.cancel(timer));
	}
}
