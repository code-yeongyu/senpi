import { describeExtensionError, type ExtensionFailure } from "../../core/extensions/error-notice.ts";

/**
 * The RPC `extension_error` record. `error` stays the raw message for existing clients; `notice` is what a
 * client shows a person (senpi#4990). Neither carries the stack, which stays in the host's debug log.
 */
export function extensionErrorEvent(failure: ExtensionFailure, logPath: string) {
	return {
		type: "extension_error",
		extensionPath: failure.extensionPath,
		event: failure.event,
		error: failure.error,
		notice: describeExtensionError(failure, { logPath }),
	} as const;
}
