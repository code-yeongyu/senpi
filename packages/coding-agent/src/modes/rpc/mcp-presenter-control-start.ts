import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { internalHostDirRoots } from "./host-lifecycle-scratch.ts";
import type { PresenterAccountAuthority } from "./mcp-presenter-account.ts";
import { McpPresenterControl } from "./mcp-presenter-control.ts";
import type { PresenterHostSurface } from "./mcp-presenter-host-surface.ts";
import { MAX_SOCKET_PATH_BYTES } from "./socket-ownership.ts";

/**
 * The Windows presenter control pipe. Its name comes from its own random value, never the host's public
 * protocol instanceId, so nothing can learn it before the host listens and squat it.
 */
export function presenterPipePath(): string {
	return `\\\\.\\pipe\\senpi-presenter-${randomUUID()}`;
}

const PRESENTER_DIR_PREFIX = "senpi-presenter-";
const CONTROL_SOCKET_NAME = "control.sock";

/** The longest control socket a root can produce: mkdtemp appends exactly 6 bytes to the prefix. */
function controlSocketBytes(root: string): number {
	return Buffer.byteLength(join(root, `${PRESENTER_DIR_PREFIX}${"0".repeat(6)}`, CONTROL_SOCKET_NAME));
}

/** senpi#5858: one typed line on the host log, so an endpoint that cannot start is never mistaken for one never requested. */
function presenterControlUnavailable(reason: string): void {
	process.stderr.write(`presenter_control_unavailable: ${reason}\n`);
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
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
		if (process.platform !== "win32") {
			// senpi#5858: bind only under a root whose longest mkdtemp result still fits sun_path - the OS temp
			// directory first, then /tmp, the same roots the host's internal hop has used since senpi#3487.
			const roots = internalHostDirRoots();
			const root = roots.find((candidate) => controlSocketBytes(candidate) <= MAX_SOCKET_PATH_BYTES);
			if (root === undefined) {
				presenterControlUnavailable(
					`socket_path_too_long: every candidate root exceeds the limit (longest control socket ${Math.max(
						...roots.map(controlSocketBytes),
					)} bytes, limit ${MAX_SOCKET_PATH_BYTES} bytes); set TMPDIR to a shorter directory`,
				);
				bootstrap?.destroy();
				return undefined;
			}
			dir = await mkdtemp(join(root, PRESENTER_DIR_PREFIX));
		}
		control = new McpPresenterControl(host, dir ? join(dir, CONTROL_SOCKET_NAME) : presenterPipePath(), account);
		await control.listen();
		if (bootstrap) control.bootstrap(bootstrap);
		return { control, ...(dir && { dir }) };
	} catch (cause) {
		presenterControlUnavailable(
			control === undefined
				? `${errorText(cause)} (limit ${MAX_SOCKET_PATH_BYTES} bytes)`
				: `${errorText(cause)} (control socket ${control.path}, ${Buffer.byteLength(control.path)} bytes, limit ${MAX_SOCKET_PATH_BYTES} bytes)`,
		);
		bootstrap?.destroy();
		control?.dispose();
		if (dir) await rm(dir, { recursive: true, force: true });
		return undefined;
	}
}
