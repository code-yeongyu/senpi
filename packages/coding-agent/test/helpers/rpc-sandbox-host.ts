import { observeProtocolInfo, probeHost } from "../../src/modes/rpc/host-probe.ts";
import type { HostProtocolInfo } from "../../src/modes/rpc/host-protocol-info.ts";
import { RpcClient, type RpcClientOptions } from "../../src/modes/rpc/rpc-client.ts";

/**
 * A sandbox a test starts a real host in. The host publishes its key record under `agentDir`, so every dial a test makes
 * of it proves the host from there (omo#15197). Pass the key root explicitly rather than through SENPI_RPC_KEY_ROOT: an
 * environment root outranks every other, and would hide a client that resolves the wrong root on its own.
 */
export type RpcSandbox = { readonly agentDir: string; readonly socket?: string };

function socketOf(sandbox: RpcSandbox, socket: string | undefined): string {
	const path = socket ?? sandbox.socket;
	if (path === undefined) throw new Error(`no socket for the sandbox at ${sandbox.agentDir}`);
	return path;
}

export function probeSandboxHost(
	sandbox: RpcSandbox,
	options: { readonly socket?: string; readonly timeoutMs?: number } = {},
): Promise<HostProtocolInfo | undefined> {
	return probeHost({
		socket: socketOf(sandbox, options.socket),
		keyRoot: sandbox.agentDir,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});
}

export function observeSandboxHost(
	sandbox: RpcSandbox,
	timeoutMs: number,
	socket?: string,
): Promise<HostProtocolInfo | undefined> {
	return observeProtocolInfo(socketOf(sandbox, socket), timeoutMs, { keyRoot: sandbox.agentDir });
}

export function sandboxRpcClient(
	sandbox: RpcSandbox,
	options: Omit<RpcClientOptions, "keyRoot" | "socketPath"> & { readonly socketPath?: string } = {},
): RpcClient {
	return new RpcClient({ ...options, socketPath: socketOf(sandbox, options.socketPath), keyRoot: sandbox.agentDir });
}
