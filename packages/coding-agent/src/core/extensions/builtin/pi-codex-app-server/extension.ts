import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../types.ts";
import { PI_CODEX_APP_SERVER_PROTOCOL_VERSION } from "./protocol-core.ts";

export const PI_CODEX_APP_SERVER_COMMAND = "pi-codex-app-server";
export const PI_CODEX_APP_SERVER_FLAG_ENABLED = "pi-codex-app-server";
export const PI_CODEX_APP_SERVER_FLAG_MODE = "pi-codex-app-server-mode";

const DEFAULT_TRANSPORT_MODE = "stdio";
const SKELETON_NOTICE = [
	"pi-codex-app-server PR-002 skeleton",
	`Protocol contract: ${PI_CODEX_APP_SERVER_PROTOCOL_VERSION}`,
	"Runtime transport is intentionally deferred.",
].join("\n");

export interface PiCodexAppServerExtensionApi {
	readonly registerCommand: ExtensionAPI["registerCommand"];
	readonly registerFlag: ExtensionAPI["registerFlag"];
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
}

export function registerPiCodexAppServerExtension(pi: PiCodexAppServerExtensionApi): void {
	pi.registerFlag(PI_CODEX_APP_SERVER_FLAG_ENABLED, {
		type: "boolean",
		default: false,
		description: "Enable the pi-codex-app-server skeleton surface without starting runtime transport.",
	});
	pi.registerFlag(PI_CODEX_APP_SERVER_FLAG_MODE, {
		type: "string",
		default: DEFAULT_TRANSPORT_MODE,
		description: "Select the future pi-codex-app-server transport mode: stdio, websocket, or unix.",
	});
	pi.registerCommand(PI_CODEX_APP_SERVER_COMMAND, {
		description: "Inspect the Codex app-server adapter skeleton status",
		handler: async (_args, ctx) => {
			notifyIfVisible(ctx, SKELETON_NOTICE);
		},
	});
	pi.on("session_start", () => undefined);
	pi.on("session_shutdown", () => undefined);
}

function notifyIfVisible(ctx: ExtensionContext, message: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, "info");
}
