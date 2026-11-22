import { activateCredentialProxy, releaseCredentialProxy } from "../../../credential-proxy/runtime.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI } from "../../types.ts";

/**
 * Starts the credential injection proxy for the credentials the user's global settings declare (senpi#6820). Agent
 * commands get a placeholder for each declared variable and, where configured, a base URL routed through the proxy.
 */
export default function credentialProxyExtension(pi: ExtensionAPI): void {
	const holder = {};
	pi.on("session_start", async (_event, ctx) => {
		const settings = SettingsManager.create(ctx.cwd, ctx.agentDir).getGlobalSettings().credentialProxy;
		try {
			await activateCredentialProxy({
				holder,
				settings,
				warn: (message) => ctx.ui.notify(`[senpi:credential-proxy] ${message}`, "warning"),
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`[senpi:credential-proxy] the proxy could not start (${detail}); declared credentials stay withheld from agent commands`,
				"error",
			);
		}
	});
	pi.on("session_shutdown", async () => {
		await releaseCredentialProxy(holder);
	});
}
