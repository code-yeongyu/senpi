export { Client, createClientServiceTransport } from "./client.ts";
export { ClientDisposedError, DisconnectedError, ServerError } from "./errors.ts";
export { RecoveryRepairController, RecoveryRepairAdviceError, type RecoveryRepairAction } from "./recovery-repair.ts";
export type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
export type {
	AttachmentChangeListener,
	ClientOptions,
	ConnectionState,
	ConnectionStateChange,
	ListenerErrorHandler,
	ServiceSubscription,
	Unsubscribe,
} from "./types.ts";
