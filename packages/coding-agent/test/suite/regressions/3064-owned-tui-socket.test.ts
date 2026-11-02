import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { resolveTuiSocket } from "../../../src/modes/interactive/session-control-registry.ts";
import { MAX_SOCKET_PATH_BYTES } from "../../../src/modes/rpc/socket-ownership.ts";

it.skipIf(process.platform === "win32")(
	"keeps a deep agent directory's fallback socket in the owned temp root (#3064)",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "rpc-"));
		vi.stubEnv("TMPDIR", root);
		let socket: string | undefined;
		try {
			socket = await resolveTuiSocket(join(root, "deep-".repeat(40)), crypto.randomUUID());
			expect(socket.startsWith(`${root}/`)).toBe(true);
			expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
		} finally {
			vi.unstubAllEnvs();
			if (socket && !socket.startsWith(`${root}/`))
				await rm(dirname(dirname(socket)), { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	},
);
