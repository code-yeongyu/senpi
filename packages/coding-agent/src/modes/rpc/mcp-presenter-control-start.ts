import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { PresenterAccountAuthority } from "./mcp-presenter-account.ts";
import { McpPresenterControl } from "./mcp-presenter-control.ts";
import type { PresenterHostSurface } from "./mcp-presenter-host-surface.ts";

/**
 * The Windows presenter control pipe. Its name comes from its own random value, never the host's public
 * protocol instanceId, so nothing can learn it before the host listens and squat it.
 */
export function presenterPipePath(): string {
	return `\\\\.\\pipe\\senpi-presenter-${randomUUID()}`;
}

export interface McpPresenterControlStart {
	readonly control: McpPresenterControl;
	/** The private directory holding the POSIX control socket; the host removes it at shutdown. */
	readonly dir?: string;
}

/**
 * Starts the management endpoint of an enforced host that can introduce a principal: through the inherited fd-4
 * bootstrap, an injected account authority, or both (senpi#4249). Otherwise the bootstrap is destroyed and no
 * control exists. A failed start leaves the host without a presenter.
 */
export async function startMcpPresenterControl(
	host: PresenterHostSurface,
	options: {
		readonly enforcement?: boolean | undefined;
		readonly bootstrap?: Duplex | undefined;
		readonly account?: PresenterAccountAuthority | undefined;
	},
): Promise<McpPresenterControlStart | undefined> {
	const { bootstrap, account } = options;
	if (options.enforcement !== true || (!bootstrap && !account)) {
		bootstrap?.destroy();
		return undefined;
	}
	let dir: string | undefined;
	let control: McpPresenterControl | undefined;
	try {
		if (process.platform !== "win32") dir = await mkdtemp(join(tmpdir(), "senpi-presenter-"));
		control = new McpPresenterControl(host, dir ? join(dir, "control.sock") : presenterPipePath(), account);
		await control.listen();
		if (bootstrap) control.bootstrap(bootstrap);
		return { control, ...(dir && { dir }) };
	} catch {
		bootstrap?.destroy();
		control?.dispose();
		if (dir) await rm(dir, { recursive: true, force: true });
		return undefined;
	}
}
