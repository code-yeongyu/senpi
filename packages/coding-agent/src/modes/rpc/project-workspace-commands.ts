/**
 * The session workspace's project trust and project-scope settings over RPC (senpi#6176).
 *
 * Trust: the choices are exactly the ones `/trust` offers (`getProjectTrustOptions` without the session-only
 * entries), and choosing one saves exactly what that choice saves in `trust.json`. It is never implied: only an
 * explicit `set_project_trust` writes, and a launch that named the trust (`--approve`/`--no-approve`) refuses it, because
 * that flag outranks every saved decision. The session then takes the decision the way a Full access change does
 * (`applyProjectTrustChange`): project settings, skills, prompts, extensions and MCP servers load or unload at once.
 *
 * Settings: the project settings file is read as stored (reading runs nothing, so trust does not gate it) and written
 * one top-level key at a time through `SettingsManager`'s own project write path, which refuses an untrusted project.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import { getSettingsPath, type ProjectSettingsFile } from "../../core/settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	ProjectTrustStore,
} from "../../core/trust-manager.ts";
import {
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_PROJECT_NOT_TRUSTED,
	RPC_ERROR_PROJECT_SETTINGS_UNREADABLE,
	RPC_ERROR_PROJECT_TRUST_LOCKED,
} from "./rpc-error-types.ts";

export type ProjectTrustChoice = "trust" | "trust_parent" | "do_not_trust";

export interface RpcProjectTrustChoice {
	choice: ProjectTrustChoice;
	label: string;
	trusted: boolean;
	/** The folder the choice saves its decision for. */
	path: string;
}

export interface RpcProjectTrust {
	cwd: string;
	/** Whether this session runs with the project trusted now. */
	projectTrusted: boolean;
	/** Whether the folder has anything trust gates; without it the project counts as trusted. */
	requiresTrust: boolean;
	/** The nearest saved decision at or above the folder, as `/trust` shows it. */
	saved: { path: string; trusted: boolean } | null;
	/** The launch named the trust (`--approve`/`--no-approve`); `set_project_trust` is refused. */
	locked: boolean;
	choices: RpcProjectTrustChoice[];
}

export type ProjectCommandResult<T> = { ok: true; data: T } | { ok: false; message: string; errorCode: string };

/** A top-level settings key: an identifier, so no prototype key or path ever reaches the file. */
const SETTINGS_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

function choiceOf(option: ProjectTrustOption): ProjectTrustChoice {
	if (!option.trusted) return "do_not_trust";
	return option.updates.length > 1 ? "trust_parent" : "trust";
}

function trustChoices(cwd: string): Array<{ choice: ProjectTrustChoice; option: ProjectTrustOption }> {
	return getProjectTrustOptions(cwd).map((option) => ({ choice: choiceOf(option), option }));
}

export function readProjectTrust(session: AgentSession): RpcProjectTrust {
	const cwd = session.sessionManager.getCwd();
	const entry = new ProjectTrustStore(session.agentDir).getEntry(cwd);
	return {
		cwd,
		projectTrusted: session.settingsManager.isProjectTrusted(),
		requiresTrust: hasTrustRequiringProjectResources(cwd),
		saved: entry === null ? null : { path: entry.path, trusted: entry.decision },
		locked: session.settingsManager.isProjectTrustLocked(),
		choices: trustChoices(cwd).map(({ choice, option }) => ({
			choice,
			label: option.label,
			trusted: option.trusted,
			path: option.savedPath ?? cwd,
		})),
	};
}

export async function writeProjectTrust(
	session: AgentSession,
	choice: unknown,
): Promise<ProjectCommandResult<RpcProjectTrust>> {
	const cwd = session.sessionManager.getCwd();
	const selected = trustChoices(cwd).find((entry) => entry.choice === choice);
	if (selected === undefined) {
		return {
			ok: false,
			message: `set_project_trust requires 'choice' to be one of: ${trustChoices(cwd)
				.map((entry) => entry.choice)
				.join(", ")}.`,
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	}
	const settings = session.settingsManager;
	if (settings.isProjectTrustLocked()) {
		return {
			ok: false,
			message: "This engine was launched with an explicit project trust flag; a saved decision cannot change it.",
			errorCode: RPC_ERROR_PROJECT_TRUST_LOCKED,
		};
	}
	new ProjectTrustStore(session.agentDir).setMany(selected.option.updates);
	// As resolveProjectTrusted: a folder with nothing trust gates is trusted whatever is saved.
	const trusted = hasTrustRequiringProjectResources(cwd) ? selected.option.trusted : true;
	if (settings.isProjectTrusted() !== trusted) {
		settings.setProjectTrusted(trusted);
		await session.applyProjectTrustChange();
	}
	return { ok: true, data: readProjectTrust(session) };
}

export interface RpcProjectSettings extends ProjectSettingsFile {
	cwd: string;
	projectTrusted: boolean;
}

export function readProjectSettings(session: AgentSession): RpcProjectSettings {
	const cwd = session.sessionManager.getCwd();
	const path = getSettingsPath(cwd, session.agentDir, "project");
	return {
		cwd,
		projectTrusted: session.settingsManager.isProjectTrusted(),
		...session.settingsManager.readProjectSettingsFile(path),
	};
}

export async function writeProjectSetting(
	session: AgentSession,
	key: unknown,
	value: unknown,
): Promise<ProjectCommandResult<RpcProjectSettings>> {
	if (typeof key !== "string" || !SETTINGS_KEY.test(key) || value === undefined) {
		return {
			ok: false,
			message: "set_project_setting requires an identifier 'key' and a JSON 'value' (null removes the key).",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	}
	const settings = session.settingsManager;
	if (!settings.isProjectTrusted()) {
		return {
			ok: false,
			message: "Project is not trusted; refusing to write project settings. Trust it with set_project_trust first.",
			errorCode: RPC_ERROR_PROJECT_NOT_TRUSTED,
		};
	}
	const file = readProjectSettings(session);
	if (file.error !== null) {
		return { ok: false, message: file.error, errorCode: RPC_ERROR_PROJECT_SETTINGS_UNREADABLE };
	}
	await settings.setProjectSetting(key, value);
	return { ok: true, data: readProjectSettings(session) };
}
