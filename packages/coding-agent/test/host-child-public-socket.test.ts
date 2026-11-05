/**
 * omo#12486: the supervisor gives its host child the PUBLIC socket on every platform. A child that is
 * not told stamps no `host_socket` on its sessions, so a host session cannot register a control
 * endpoint and nothing drains its gateway deliveries (a Windows desktop thread never started a turn).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostChildEnvironment } from "../src/modes/rpc/host-lifecycle-launch.ts";
import { HOST_PUBLIC_SOCKET_ENV, readHostWatchdogConfig } from "../src/modes/rpc/host-watchdog.ts";
import { hostSessionContext } from "../src/modes/rpc/multi-session-host.ts";

const root = join(process.cwd(), "host-child-public-socket");
const publicSocket = join(root, "rpc", "rpc.sock");

function childEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
	return hostChildEnvironment(
		{
			launch: { socket: publicSocket, hostArgs: [] },
			internalSocket: join(root, "internal", "host.sock"),
			internal: { secretPath: join(root, "internal", "host.sock.secret") },
			daemonDir: join(root, "daemon"),
			instanceId: "instance-under-test",
			cleanupPaths: [],
			publicSocket,
		},
		undefined,
		platform,
	);
}

describe.each(["win32", "darwin", "linux"] as const)("host child environment on %s", (platform) => {
	it("carries the public socket, and the child stamps it as its sessions' host_socket", () => {
		const env = childEnvironment(platform);
		expect(env[HOST_PUBLIC_SOCKET_ENV]).toBe(publicSocket);

		const binding = readHostWatchdogConfig(env);
		expect(binding?.publicSocket).toBe(publicSocket);
		const context = hostSessionContext(join(root, "internal", "host.sock"), binding);
		expect(context.host_socket).toBe(publicSocket);
	});
});
