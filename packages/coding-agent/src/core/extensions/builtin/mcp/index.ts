import type { ExtensionAPI } from "../../types.ts";
import { getMcpService, shouldDisposeMcpService } from "./service.ts";

export default function mcpExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		getMcpService().attachSession(event, ctx);
	});

	pi.on("session_shutdown", (event) => {
		if (shouldDisposeMcpService(event.reason)) {
			getMcpService().dispose(event.reason);
		}
	});
}
