import type { RpcExtensionUIResponse } from "./rpc-types.ts";

type PendingRequest = {
	resolve: (value: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Per-session extension UI request state; never share this map between bindings. */
export class SessionExtensionUiRequests {
	private readonly pending = new Map<string, PendingRequest>();

	set(id: string, request: PendingRequest): void {
		this.pending.set(id, request);
	}

	delete(id: string): void {
		this.pending.delete(id);
	}

	resolve(response: RpcExtensionUIResponse): boolean {
		const request = this.pending.get(response.id);
		if (!request) return false;
		this.pending.delete(response.id);
		request.resolve(response);
		return true;
	}

	close(): void {
		for (const request of this.pending.values()) {
			request.reject(new Error("Extension UI request cancelled: session closed"));
		}
		this.pending.clear();
	}
}
