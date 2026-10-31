// SC-LIVE setup, run with Bun before the CLI starts: writes the work dir's `.senpi/hooks.json` (one PreToolUse and one
// PostToolUse command hook on every tool, matcher "*") and the matching `hooks-state.json` trust record, exactly as a
// user who approved those hooks would have them (the writer the EQ E04 fixture uses).
//
//   bun write-hooks.ts <cwd> <hook command>
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

const [cwd, command] = process.argv.slice(2);
if (!cwd || !command) throw new Error("usage: write-hooks.ts <cwd> <hook command>");

const senpiDir = join(cwd, ".senpi");
mkdirSync(senpiDir, { recursive: true });
const sourcePath = join(senpiDir, "hooks.json");
const hookConfig = {
	hooks: {
		PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
		PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
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
		updatedAt: "2026-10-28T00:00:00.000Z",
	});
}
writeFileSync(join(senpiDir, "hooks-state.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, "utf-8");
