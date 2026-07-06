import type { ExtensionAPI } from "../../types.ts";
import { registerMcpCommands } from "./commands.ts";
import { injectMcpInstructions, refreshMcpInstructionsForSession } from "./instructions.ts";
import { createMcpLogger } from "./log.ts";
import { getMcpService } from "./service.ts";
import { reportMcpAsyncError, wrapAsync } from "./wrap.ts";

export default function mcpExtension(pi: ExtensionAPI): void {
	let attached = false;
	const sink = {
		logger: {
			error(message: string, data?: unknown): void {
				createMcpLogger("service").error(message, data);
			},
		},
	};

	registerMcpCommands(pi);
	pi.on(
		"session_start",
		wrapAsync(
			"mcp.session_start",
			async (event, ctx) => {
				const service = getMcpService();
				await service.attachSession(event, ctx, pi);
				refreshMcpInstructionsForSession(service);
				attached = true;
			},
			sink,
		),
	);
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!attached) {
				const service = getMcpService();
				await service.attachSession({ type: "session_start", reason: "startup" }, ctx, pi);
				refreshMcpInstructionsForSession(service);
				attached = true;
			}
			const systemPrompt = injectMcpInstructions(event.systemPrompt);
			return systemPrompt === undefined ? undefined : { systemPrompt };
		} catch (error) {
			await reportMcpAsyncError("mcp.before_agent_start", error, sink);
			return undefined;
		}
	});
	pi.on(
		"session_shutdown",
		wrapAsync("mcp.session_shutdown", (event) => getMcpService().handleSessionShutdown(event), sink),
	);
}
