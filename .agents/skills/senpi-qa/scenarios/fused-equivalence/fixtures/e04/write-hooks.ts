// E04 setup, run with Bun before the CLI starts: writes the project's `.senpi/hooks.json` (one PreToolUse and one
// PostToolUse command hook for the `qa` tool) and the matching `hooks-state.json` trust record, exactly as a user who
// approved those hooks would have them (same writer the G1 fixture uses, test/fixtures/qa-tool/qa-tool-fixture.ts).
//
//   bun write-hooks.ts <cwd> <pre-hook command> <post-hook command>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHookConfig } from "../../../../../../../packages/coding-agent/src/core/extensions/builtin/hooks/index.ts";
import {
	createHookTrustEntry,
	hookTrustId,
} from "../../../../../../../packages/coding-agent/src/core/extensions/builtin/hooks/trust.ts";
import type {
	HookSourceMetadata,
	HookTrustEntry,
} from "../../../../../../../packages/coding-agent/src/core/extensions/builtin/hooks/types.ts";

const [cwd, preCommand, postCommand] = process.argv.slice(2);
if (!cwd || !preCommand || !postCommand) throw new Error("usage: write-hooks.ts <cwd> <pre command> <post command>");

const senpiDir = join(cwd, ".senpi");
mkdirSync(senpiDir, { recursive: true });
const sourcePath = join(senpiDir, "hooks.json");
const hookConfig = {
	hooks: {
		PreToolUse: [{ matcher: "qa", hooks: [{ type: "command", command: preCommand }] }],
		PostToolUse: [{ matcher: "qa", hooks: [{ type: "command", command: postCommand }] }],
	},
};
writeFileSync(sourcePath, `${JSON.stringify(hookConfig, null, 2)}\n`, "utf-8");
const source = {
	discoveredAt: "pre-session",
	displayOrder: 0,
	scope: "project",
	sourcePath,
} satisfies HookSourceMetadata;
const hooks: Record<string, HookTrustEntry> = {};
for (const handler of parseHookConfig(hookConfig, source).executableHandlers) {
	hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
		platform: process.platform,
		updatedAt: "2026-10-27T00:00:00.000Z",
	});
}
writeFileSync(join(senpiDir, "hooks-state.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, "utf-8");
