export type SecureFileMonitorWorkerEvent =
	| { readonly type: "created" | "modified" }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "timed_out" };

export interface SecureFileMonitorWorkerRegistration {
	readonly reconcile: () => Promise<void>;
	readonly stop: () => Promise<void>;
}

export interface RegisterSecureFileMonitorOptions {
	readonly directory: string;
	readonly expectedDevice: bigint;
	readonly expectedInode: bigint;
	readonly targetName: string;
	readonly event: "create" | "modify";
	readonly timeoutMs: number;
	readonly onEvent: (event: SecureFileMonitorWorkerEvent) => void;
}

export interface SecureFileMonitorWorkerPoolOptions {
	readonly onError?: (error: Error) => void;
	readonly requestTimeoutMs?: number;
	readonly startupTimeoutMs?: number;
	readonly workerCommand?: readonly [executable: string, ...args: string[]];
}

export type SecureWorkerRequestSuccessType = "cancelled" | "reconciled" | "registered";

export type SecureWorkerResponse =
	| {
			readonly device: string;
			readonly inode: string;
			readonly type: "ready";
	  }
	| {
			readonly requestId: number;
			readonly type: SecureWorkerRequestSuccessType;
	  }
	| {
			readonly message: string;
			readonly requestId: number;
			readonly type: "request_error";
	  }
	| {
			readonly event: SecureFileMonitorWorkerEvent;
			readonly id: string;
			readonly type: "event";
	  };
