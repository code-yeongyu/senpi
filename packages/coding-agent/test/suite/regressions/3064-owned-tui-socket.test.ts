import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveTuiSocket } from "../../../src/modes/interactive/session-control-registry.ts";
import { MAX_SOCKET_PATH_BYTES } from "../../../src/modes/rpc/socket-ownership.ts";
import { tuiSocketName } from "../../../src/modes/rpc/tui-socket.ts";

// The fallback socket is `<temp root>/senpi-rpc-<8hex>/t-<16hex>.sock`, so the longest temp root that still holds it
// within sun_path is MAX_SOCKET_PATH_BYTES minus that suffix (#3064, #3758). The roots below are built to exact byte
// lengths under a short base, so both sides of the boundary are exercised whatever the host's TMPDIR is.
const FALLBACK_SUFFIX_BYTES = Buffer.byteLength(join("/senpi-rpc-00000000", tuiSocketName("instance")));
const LONGEST_OWNED_ROOT_BYTES = MAX_SOCKET_PATH_BYTES - FALLBACK_SUFFIX_BYTES;

let base: string;
const cleanups: string[] = [];

beforeEach(async () => {
	base = await mkdtemp("/tmp/senpi-3064-");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
	await rm(base, { recursive: true, force: true });
});

async function tempRootOfBytes(bytes: number): Promise<string> {
	const root = join(base, "p".repeat(bytes - Buffer.byteLength(base) - 1));
	await mkdir(root, { mode: 0o700 });
	expect(Buffer.byteLength(root)).toBe(bytes);
	vi.stubEnv("TMPDIR", root);
	return root;
}

it.skipIf(process.platform === "win32")(
	"keeps a deep agent directory's fallback socket in the owned temp root while it fits there (#3064)",
	async () => {
		const root = await tempRootOfBytes(LONGEST_OWNED_ROOT_BYTES);
		const socket = await resolveTuiSocket(join(root, "deep-".repeat(40)), crypto.randomUUID());
		expect(socket.startsWith(`${root}/`)).toBe(true);
		expect(Buffer.byteLength(socket)).toBe(MAX_SOCKET_PATH_BYTES);
	},
);

it.skipIf(process.platform === "win32")(
	"moves the fallback socket to a private /tmp directory only when no owned path fits (#3758)",
	async () => {
		const root = await tempRootOfBytes(LONGEST_OWNED_ROOT_BYTES + 1);
		const agentDir = join(root, "deep-".repeat(40));
		const shortRoot = join("/tmp", `senpi-rpc-${createHash("sha256").update(agentDir).digest("hex").slice(0, 8)}`);
		cleanups.push(shortRoot);
		const socket = await resolveTuiSocket(agentDir, crypto.randomUUID());
		expect(dirname(socket)).toBe(shortRoot);
		expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
		const stat = await lstat(shortRoot);
		expect(stat.isDirectory()).toBe(true);
		expect(stat.mode & 0o777).toBe(0o700);
	},
);
