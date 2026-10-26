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

	resolve(response: RpcExtensionUIResponse, beforeAnswer?: () => void): boolean {
		const request = this.pending.get(response.id);
		if (!request) return false;
		beforeAnswer?.();
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
