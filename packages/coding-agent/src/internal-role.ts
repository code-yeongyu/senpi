/**
 * Internal process roles (senpi#3566, plan todo 4). Imported at the top of every CLI entry, so a process the engine
 * started as a tool child becomes one before version dispatch, argument parsing or the CLI module graph. Without its
 * channel environment a role process exits 70 at once instead of falling through to the ordinary CLI.
 */
import { channelEnvPresent, TOOL_CHILD_ROLE_ENV } from "./modes/rpc/tool-child/channel.ts";

const role = process.env[TOOL_CHILD_ROLE_ENV];

if (role !== undefined && role !== "") {
	if (role === "launch-shim") {
		// Windows only: starts one detached command outside the child's Job Object (senpi#3566).
		const { runLaunchShimRole } = await import("./modes/rpc/tool-child/launch-shim-role.ts");
		runLaunchShimRole();
	}
	if (role !== "tool-child") {
		process.stderr.write(`senpi: unknown internal role ${JSON.stringify(role)}\n`);
		process.exit(70);
	}
	if (!channelEnvPresent(process.env)) {
		process.stderr.write("tool-child: channel unavailable\n");
		process.exit(70);
	}
	// The role module stays out of the CLI graph: a tool child must never load the session, provider or TUI modules.
	const { runToolChildRole } = await import("./modes/rpc/tool-child/role.ts");
	await runToolChildRole();
}
