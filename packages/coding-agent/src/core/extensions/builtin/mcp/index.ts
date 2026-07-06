import type { ExtensionAPI } from "../../types.ts";
import { createMcpLogger } from "./log.ts";
import { getMcpService } from "./service.ts";
import { wrapAsync } from "./wrap.ts";

export default function mcpExtension(pi: ExtensionAPI): void {
	const sink = {
		logger: {
			error(message: string, data?: unknown): void {
				createMcpLogger("service").error(message, data);
			},
		},
	};

	pi.on(
		"session_start",
		wrapAsync("mcp.session_start", (event, ctx) => getMcpService().attachSession(event, ctx, pi), sink),
	);
	pi.on(
		"session_shutdown",
		wrapAsync("mcp.session_shutdown", (event) => getMcpService().handleSessionShutdown(event), sink),
	);
}
