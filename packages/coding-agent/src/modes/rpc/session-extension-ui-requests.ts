import type { UiRequestChange } from "./snapshot-types.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types.ts";

type PendingRequest = {
	resolve: (value: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
	frame?: RpcExtensionUIRequest;
};

export const sessionDialogRequests = new WeakMap<object, SessionExtensionUiRequests>();

/** Per-session extension UI request state; never share this map between bindings. */
export class SessionExtensionUiRequests {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly claimed = new Set<string>();
	private readonly changed: ((change?: UiRequestChange) => void) | undefined;
	constructor(changed?: (change?: UiRequestChange) => void) {
		this.changed = changed;
	}

	set(id: string, request: PendingRequest): void {
		this.pending.set(id, request);
		this.changed?.(
			request.frame
				? { type: "ui_request_pending", uiRequestId: id, method: request.frame.method, request: request.frame }
				: undefined,
		);
	}

	delete(id: string): void {
		if (this.pending.delete(id))
			this.changed?.({ type: "ui_request_settled", uiRequestId: id, disposition: "cancelled" });
	}

	snapshot(): RpcExtensionUIRequest[] {
		return [...this.pending.values()].flatMap((request) => (request.frame ? [request.frame] : []));
	}

	/**
	 * The first answer wins: it claims the request before `beforeAnswer` runs, so an answer that arrives while
	 * `beforeAnswer` runs finds the request claimed and settles nothing. A claim whose `beforeAnswer` throws is
	 * released and the request stays pending. The request stays listed in `snapshot()` until it settles.
	 */
	resolve(response: RpcExtensionUIResponse, beforeAnswer?: () => void): boolean {
		const request = this.pending.get(response.id);
		if (!request || this.claimed.has(response.id)) return false;
		this.claimed.add(response.id);
		try {
			beforeAnswer?.();
		} finally {
			this.claimed.delete(response.id);
		}
		// A cancel or close that ran inside `beforeAnswer` settled the request first.
		if (this.pending.get(response.id) !== request) return false;
		this.pending.delete(response.id);
		this.changed?.({
			type: "ui_request_settled",
			uiRequestId: response.id,
			disposition: "cancelled" in response ? "cancelled" : "answered",
		});
		request.resolve(response);
		return true;
	}

	cancelAll(): void {
		for (const [id, request] of this.pending) {
			this.delete(id);
			request.resolve({ type: "extension_ui_response", id, cancelled: true });
		}
	}

	close(): void {
		for (const [id, request] of this.pending) {
			this.delete(id);
			request.reject(new Error("Extension UI request cancelled: session closed"));
		}
	}
}
