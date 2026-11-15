import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";

const fixtures = join(import.meta.dirname, "..", "..", "fixtures");
const child = join(fixtures, "sdk-host-private-fds-child.ts");
const extension = join(fixtures, "sdk-host-private-fds-extension.ts");
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

// The declaration names a channel without handing a descriptor over (fd 5 is not open in the child): adoption keeps
// the name declared, and the contract under test is only that no extension evaluates while the table is in the env.
describe.skipIf(process.platform === "win32" || !bunAvailable)(
	"senpi#6771: an SDK host's extensions never see the private-descriptor table in the environment",
	() => {
		it("adopts the table before the first extension module evaluates", () => {
			const agentDir = mkdtempSync(join(tmpdir(), "senpi-6771-"));
			try {
				const run = spawnSync("bun", [child, extension, agentDir], {
					encoding: "utf8",
					env: {
						...hostSpawnEnv(),
						SENPI_CODING_AGENT_DIR: agentDir,
						SENPI_PRIVATE_FDS: JSON.stringify({ "memory-sync": 5 }),
						SENPI_PRIVATE_FDS_FINAL: "1",
					},
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 60_000,
				});
				expect(run.status, run.stderr).toBe(0);
				expect(JSON.parse(run.stdout.trim())).toEqual({
					seen: null,
					declared: true,
					envAfter: null,
					errors: [],
				});
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		}, 60_000);
	},
);
