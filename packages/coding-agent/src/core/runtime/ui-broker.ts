import { SessionExtensionUiRequests } from "../../modes/rpc/session-extension-ui-requests.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../../modes/rpc/rpc-types.ts";
import { noOpUIContext } from "../extensions/runner.ts";
import { SecretInputUnavailableError } from "../extensions/secret-input.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../extensions/types.ts";

/**
 * The UI of a runtime that has no session (senpi#5228). One presenter at a time answers the runtime's extension
 * UI requests; with none attached, every request settles as an unbound UI does.
 */
export class RuntimeUiBroker {
	#presenter: ExtensionUIContext | undefined;

	get presenter(): ExtensionUIContext | undefined {
		return this.#presenter;
	}

	/** Attach the presenter that answers this runtime's UI requests; the returned function detaches it. */
	attach(presenter: ExtensionUIContext): () => void {
		if (this.#presenter !== undefined) throw new Error("A presenter is already attached to this runtime's UI broker");
		this.#presenter = presenter;
		return () => {
			if (this.#presenter === presenter) this.#presenter = undefined;
		};
	}
}

export interface RpcUiPresenter {
	readonly ui: ExtensionUIContext;
	/** Settle the pending request an `extension_ui_response` answers; false when none is pending under its id. */
	respond(response: RpcExtensionUIResponse): boolean;
	/** Settle every pending request as cancelled, as a client disconnect does. */
	dispose(): void;
}

function dialogCall(opts: ExtensionUIDialogOptions | undefined): { toolCallId?: string; parentToolCallId?: string } {
	if (opts?.toolCallId === undefined) return {};
	return {
		toolCallId: opts.toolCallId,
		...(opts.parentToolCallId === undefined ? {} : { parentToolCallId: opts.parentToolCallId }),
	};
}

function answeredValue(response: RpcExtensionUIResponse): string | undefined {
	return "cancelled" in response && response.cancelled ? undefined : "value" in response ? response.value : undefined;
}

/**
 * A presenter that asks over the RPC wire with the same `extension_ui_request` frames, timeouts and abort
 * handling as a session's RPC UI, for a connection that serves a runtime with no session.
 */
export function createRpcUiPresenter(output: (frame: RpcExtensionUIRequest) => void): RpcUiPresenter {
	const pending = new SessionExtensionUiRequests();

	function dialog<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pending.delete(id);
			};
			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}
			const frame = { type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest;
			pending.set(id, {
				frame,
				resolve: (response) => {
					cleanup();
					resolve(parse(response));
				},
				reject,
			});
			output(frame);
		});
	}

	const fireAndForget = (request: Record<string, unknown>): void =>
		output({ type: "extension_ui_request", id: crypto.randomUUID(), ...request } as RpcExtensionUIRequest);

	const ui: ExtensionUIContext = {
		...noOpUIContext,
		select: (title, options, opts) =>
			dialog(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout, ...dialogCall(opts) },
				answeredValue,
			),
		confirm: (title, message, opts) =>
			dialog(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (response) =>
				"cancelled" in response && response.cancelled
					? false
					: "confirmed" in response
						? response.confirmed
						: false,
			),
		// This presenter does not speak the secret-input protocol, so a secret is refused, never asked as plain text.
		input: (title, placeholder, opts) => {
			if (opts?.secret) return Promise.reject(new SecretInputUnavailableError("client_unsupported"));
			return dialog(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout, ...dialogCall(opts) },
				answeredValue,
			);
		},
		editor: (title, prefill) => dialog(undefined, undefined, { method: "editor", title, prefill }, answeredValue),
		notify: (message, type) => fireAndForget({ method: "notify", message, notifyType: type }),
		setStatus: (key, text) => fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
		setTitle: (title) => fireAndForget({ method: "setTitle", title }),
		setProgramStatus: (status) => fireAndForget({ method: "setProgramStatus", programStatus: status }),
	};

	return {
		ui,
		respond: (response) => pending.resolve(response),
		dispose: () => pending.cancelAll(),
	};
}
