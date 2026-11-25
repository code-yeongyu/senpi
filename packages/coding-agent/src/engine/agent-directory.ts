import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, CONFIG_FLAT_LAYOUT, ENV_PREFIX, getAgentDir } from "../config.ts";
import { brandEnvNames } from "../core/brand.ts";
import { type EngineResult, engineError, engineOk } from "./result.ts";

export interface AgentDirectorySelection {
	/** The record version `config agent-dir --json` prints. */
	readonly version: 1;
	readonly ok: true;
	readonly dir: string;
	/** The branded variable that chose the directory, or `default` / `project-local`. */
	readonly source: string;
	readonly rule: "environment" | "home-default" | "project-local";
	readonly brandedPrefix: string;
}

/** The agent directory every session of this engine uses, and why it is that one. Reads nothing else. */
export function agentDirectory(): EngineResult<AgentDirectorySelection, "selection_failed"> {
	try {
		const dir = getAgentDir();
		const selector = brandEnvNames("CODING_AGENT_DIR").find((name) => process.env[name] !== undefined);
		const explicit = selector !== undefined && process.env[selector] ? selector : undefined;
		const homeDefault = CONFIG_FLAT_LAYOUT
			? join(homedir(), CONFIG_DIR_NAME)
			: join(homedir(), CONFIG_DIR_NAME, "agent");
		const rule = explicit !== undefined ? "environment" : dir === homeDefault ? "home-default" : "project-local";
		return engineOk({
			version: 1,
			ok: true,
			dir,
			source: explicit ?? (rule === "project-local" ? "project-local" : "default"),
			rule,
			brandedPrefix: ENV_PREFIX,
		});
	} catch (error) {
		return engineError(
			"selection_failed",
			error instanceof Error ? error.message : "Unable to resolve the agent directory.",
		);
	}
}
