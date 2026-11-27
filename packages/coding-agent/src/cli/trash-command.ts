/**
 * `senpi trash list|restore|empty` - the user's side of the trash the `trash` tool writes (omo#11072).
 *
 * The user is always allowed to delete permanently, so `empty` runs whatever `deletePolicy.mode` says; every
 * entry it removes is appended to the audit log. Settings come from the global settings file only: a project
 * file must not be able to shorten retention for a command run from inside that project.
 */
import { APP_NAME, getAgentDir } from "../config.ts";
import { deleteAuditFile } from "../core/extensions/builtin/delete-policy/audit.ts";
import { resolveDeletePolicy } from "../core/extensions/builtin/delete-policy/policy.ts";
import {
	type EmptySelection,
	emptyTrash,
	listTrash,
	restoreTrash,
	type TrashScope,
} from "../core/extensions/builtin/delete-policy/trash.ts";
import { TrashError } from "../core/extensions/builtin/delete-policy/trash-error.ts";
import { SettingsManager } from "../core/settings-manager.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `usage: ${APP_NAME} trash <list|restore|empty> [options]

  list     [--json]            what ${APP_NAME} moved to the trash, oldest first
  restore  <id>                move an entry back to its original path (refused if that path exists)
  empty                        apply the delete policy: drop entries past retentionDays, then the
                               oldest entries until the trash is under maxTrashBytes
  empty    --older-than <n>d   also delete entries older than n days (h, m and s also accepted)
  empty    --all               delete every entry ${APP_NAME} put in the trash

Every permanent delete is appended to the audit log (${deleteAuditFile("<agent-dir>")}).`;

class UsageError extends Error {}

const DURATION = /^(\d+)([dhms])$/;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;

function parseDuration(value: string | undefined): number {
	const match = value === undefined ? null : DURATION.exec(value);
	const unit = match?.[2];
	if (match === null || (unit !== "d" && unit !== "h" && unit !== "m" && unit !== "s")) {
		throw new UsageError("--older-than needs a duration such as 7d, 12h, 30m or 90s");
	}
	return Number(match[1]) * UNIT_MS[unit];
}

function parseEmpty(args: readonly string[]): EmptySelection {
	if (args.length === 0) return { kind: "policy" };
	if (args.length === 1 && args[0] === "--all") return { kind: "all" };
	if (args.length === 2 && args[0] === "--older-than") return { kind: "older-than", ms: parseDuration(args[1]) };
	throw new UsageError(`unknown options for empty: ${args.join(" ")}`);
}

function userScope(): TrashScope {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false }).getSettings();
	return { agentDir, policy: resolveDeletePolicy(settings), sessionId: null, actor: "user" };
}

function print(line: string): void {
	process.stdout.write(`${line}\n`);
}

async function list(args: readonly string[]): Promise<number> {
	if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) throw new UsageError("list takes only --json");
	const entries = await listTrash(userScope());
	if (args[0] === "--json") print(JSON.stringify(entries));
	else if (entries.length === 0) print("The trash holds nothing from senpi.");
	else {
		for (const entry of entries) {
			print(`${entry.id}  ${new Date(entry.deletedAt).toISOString()}  ${entry.bytes} bytes  ${entry.originalPath}`);
		}
	}
	return EXIT_OK;
}

async function restore(args: readonly string[]): Promise<number> {
	const id = args[0];
	if (args.length !== 1 || id === undefined) throw new UsageError("restore needs exactly one entry id");
	const entry = await restoreTrash(userScope(), id);
	print(`restored ${entry.id} to ${entry.originalPath}`);
	return EXIT_OK;
}

async function empty(args: readonly string[]): Promise<number> {
	const rows = await emptyTrash(userScope(), parseEmpty(args));
	const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
	for (const row of rows) print(`deleted ${row.trashId ?? "-"}  ${row.bytes} bytes  ${row.path}  (${row.reason})`);
	print(`${rows.length} entr${rows.length === 1 ? "y" : "ies"} deleted permanently, ${bytes} bytes freed.`);
	return EXIT_OK;
}

export async function runTrashCommand(args: readonly string[]): Promise<number> {
	const [verb, ...rest] = args;
	try {
		switch (verb) {
			case "list":
				return await list(rest);
			case "restore":
				return await restore(rest);
			case "empty":
				return await empty(rest);
			default:
				throw new UsageError(verb === undefined ? "missing subcommand" : `unknown subcommand: ${verb}`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${APP_NAME} trash: ${error.message}\n\n${USAGE}\n`);
			return EXIT_USAGE;
		}
		if (error instanceof TrashError) {
			process.stderr.write(`${APP_NAME} trash: ${error.message}\n`);
			return EXIT_FAILED;
		}
		throw error;
	}
}
