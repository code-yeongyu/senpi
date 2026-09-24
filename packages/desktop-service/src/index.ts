export { type ChildFactory, DesktopEngineUnavailableError, engineChildFactory } from "./service/child.ts";
export { DesktopNotificationError, type Listener, type Unsubscribe } from "./service/notifications.ts";
export {
	type CallOptions,
	DesktopEngineRpcError,
	DesktopServiceError,
	type DesktopServiceErrorCode,
} from "./service/rpc-client.ts";
export { DesktopService, type DesktopServiceOptions, type DesktopSessionOpenParams } from "./service/service.ts";
export {
	CAPABILITIES_TIMEOUT_MS,
	CLOSE_TIMEOUT_MS,
	GRACE_MS,
	HEARTBEAT_MS,
	RESTART_MESSAGE,
	START_TIMEOUT_MESSAGE,
	START_TIMEOUT_MS,
} from "./service/timeouts.ts";
