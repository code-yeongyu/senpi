import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every command a client can send must have a `#### <type>` section in the docs/rpc.md that
 * ships with the package. The command list is read from the protocol's command unions,
 * so adding a command without documenting it fails here rather than at a user's terminal.
 *
 * Commands listed in `UNDOCUMENTED` predate this check. Each one is named with the reason it is
 * exempt; remove an entry the moment its section lands so the exemption cannot outlive the gap.
 */
const UNDOCUMENTED: Record<string, string> = {
	// Described in prose (daemon handshake, client capabilities, extensions, OAuth) but with no
	// per-command block a reader can jump to.
	get_protocol_info: "daemon handshake; described in the daemon sections",
	open_session: "daemon session open; described in the daemon sections",
	close_session: "daemon detach; described in the daemon sections",
	list_sessions: "daemon listing; described in the daemon sections",
	set_client_info: "capability negotiation; described under `### Client capabilities`",
	extension_request: "extension-owned request; mentioned in the extension events section",
	login_start: "OAuth login; described under `## OAuth login`",
	login_cancel: "OAuth login; described under `## OAuth login`",
	reload: "extension reload; mentioned without a request/response block",
	account_pin: "provider accounts; mentioned under `## Account display names`",
	account_remove: "provider accounts; mentioned under `## Account display names`",
	get_provider_accounts: "provider accounts; mentioned under `## Account display names`",
	// Not mentioned anywhere in docs/rpc.md as of 2026-09-21.
	abort_branch_summary: "undocumented since it shipped",
	abort_compaction: "undocumented since it shipped",
	append_session_entry: "undocumented since it shipped",
	append_user_message: "undocumented since it shipped",
	check_reload_veto: "undocumented since it shipped",
	cleanup_bash_output: "undocumented since it shipped",
	export_jsonl: "undocumented since it shipped",
	get_auth_providers: "undocumented since it shipped",
	get_follow_up_messages: "undocumented since it shipped",
	get_steering_messages: "undocumented since it shipped",
	import_jsonl: "undocumented since it shipped",
	logout: "undocumented since it shipped",
	record_bash_result: "undocumented since it shipped",
	send_custom_message: "undocumented since it shipped",
	set_favorite_models: "undocumented since it shipped",
	set_label: "undocumented since it shipped",
	set_scoped_models: "undocumented since it shipped",
};

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..", "..");
const commandSources = [
	["rpc-session-command-types.ts", "RpcSessionCommand"],
	["rpc-host-command-types.ts", "RpcCommand"],
	["attachment-types.ts", "RpcAttachmentCommand"],
] as const;
const docsPath = join(pkgRoot, "docs", "rpc.md");

/**
 * Collect every `type: "<literal>"` inside the session, host and attachment command unions. Each
 * alias body runs from its declaration to the terminating `;` at the start of a line, which is how
 * the protocol closes those unions.
 */
function commandTypes(): string[] {
	const found = new Set<string>();
	for (const [file, alias] of commandSources) {
		const source = readFileSync(join(pkgRoot, "src", "modes", "rpc", file), "utf8");
		const start = source.search(new RegExp(`^(export )?type ${alias} =`, "m"));
		expect(start, `${alias} declaration`).toBeGreaterThanOrEqual(0);
		const end = source.indexOf("\n\t  };\n", start);
		const body = source.slice(start, end === -1 ? undefined : end);
		for (const match of body.matchAll(/\btype: "([a-z_]+)"/g)) {
			found.add(match[1]!);
		}
	}
	return [...found].sort();
}

describe("docs/rpc.md documents every RpcCommand", () => {
	const types = commandTypes();
	const docs = readFileSync(docsPath, "utf8");
	const headings = new Set(
		docs
			.split("\n")
			.filter((line) => line.startsWith("#### "))
			.map((line) => line.slice(5).trim()),
	);

	it("found the command union", () => {
		expect(types.length).toBeGreaterThan(20);
		expect(types).toContain("prompt");
	});

	it("has a #### section for every command that is not explicitly exempt", () => {
		const missing = types.filter((type) => !headings.has(type) && !(type in UNDOCUMENTED));
		expect(missing).toEqual([]);
	});

	it("keeps the exemption list honest", () => {
		const stale = Object.keys(UNDOCUMENTED).filter((type) => headings.has(type) || !types.includes(type));
		expect(stale).toEqual([]);
	});
});
