/**
 * The session workspace's project trust and project-scope settings over RPC (senpi#6176).
 *
 * Trust: the choices are exactly the ones `/trust` offers (`getProjectTrustOptions` without the session-only
 * entries), and choosing one saves exactly what that choice saves in `trust.json`. It is never implied: only an
 * explicit `set_project_trust` writes, and a launch that named the trust (`--approve`/`--no-approve`) refuses it, because
 * that flag outranks every saved decision. Then, in the order `resolveProjectTrusted` decides a session's trust, a folder
 * with nothing trust gates stays trusted, and a `project_trust` handler of the extensions loaded before trust (never a
 * project extension) decides before any saved choice: a choice it decides against is refused, with nothing saved and
 * nothing applied. Otherwise the session takes the decision the way a Full access change does
 * (`applyProjectTrustChange`), in line with the runtime's own trust changes: project settings, skills, prompts,
 * extensions and MCP servers load or unload at once.
 *
 * Settings: the project settings file is read as stored (reading runs nothing, so trust does not gate it) and written
 * one top-level key at a time through `SettingsManager`'s own project write path, which refuses an untrusted project.
 * Only allowlisted keys are written as given; every other key is decided first (`project-setting-policy.ts`).
 */

import { createHeadlessProjectTrustContext } from "../../cli/project-trust-headless.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { emitProjectTrustEvent } from "../../core/extensions/runner.ts";
import { getSettingsPath, type ProjectSettingsFile } from "../../core/settings-manager.ts";
import { getProjectTrustOptions, type ProjectTrustOption, ProjectTrustStore } from "../../core/trust-manager.ts";
import { hasTrustRequiringProjectResourcesAsync } from "../../core/trust-requiring-resources.ts";
import { refuseProjectSettingWrite } from "./project-setting-policy.ts";
import {
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_PROJECT_NOT_TRUSTED,
	RPC_ERROR_PROJECT_SETTINGS_UNREADABLE,
	RPC_ERROR_PROJECT_SETTINGS_WRITE_FAILED,
	RPC_ERROR_PROJECT_TRUST_EXTENSION_DECIDED,
	RPC_ERROR_PROJECT_TRUST_LOCKED,
} from "./rpc-error-types.ts";

/** Runs a trust change after every trust change the session's runtime already started (Full access syncs). */
export type InTrustChangeOrder = <T>(task: () => Promise<T>) => Promise<T>;

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

export async function readProjectTrust(session: AgentSession): Promise<RpcProjectTrust> {
	const cwd = session.sessionManager.getCwd();
	const entry = new ProjectTrustStore(session.agentDir).getEntry(cwd);
	return {
		cwd,
		projectTrusted: session.settingsManager.isProjectTrusted(),
		requiresTrust: await hasTrustRequiringProjectResourcesAsync(cwd),
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

/**
 * What a `project_trust` handler decides for `cwd`, asked as a session open asks it: the handlers of the extensions
 * loaded before trust (`loadProjectTrustExtensions` leaves project extensions out), first decided answer wins, no UI.
 * A handler that throws falls through, as in `resolveProjectTrusted`, and is reported on stderr like its warning.
 */
async function extensionTrustDecision(session: AgentSession, cwd: string): Promise<boolean | undefined> {
	const loaded = session.resourceLoader.getExtensions();
	const preTrust = { ...loaded, extensions: loaded.extensions.filter((ext) => ext.sourceInfo.scope !== "project") };
	const { result, errors } = await emitProjectTrustEvent(
		preTrust,
		{ type: "project_trust", cwd },
		createHeadlessProjectTrustContext({ cwd, mode: "rpc", hasUI: false }),
	);
	for (const error of errors) {
		process.stderr.write(`senpi rpc: Extension "${error.extensionPath}" project_trust error: ${error.error}\n`);
	}
	return result === undefined ? undefined : result.trusted === "yes";
}

export async function writeProjectTrust(
	session: AgentSession,
	choice: unknown,
	inTrustChangeOrder: InTrustChangeOrder,
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
	return inTrustChangeOrder(async (): Promise<ProjectCommandResult<RpcProjectTrust>> => {
		// As resolveProjectTrusted: a folder with nothing trust gates is trusted whatever is saved or decided.
		const requiresTrust = await hasTrustRequiringProjectResourcesAsync(cwd);
		const decided = requiresTrust ? await extensionTrustDecision(session, cwd) : undefined;
		if (decided !== undefined && decided !== selected.option.trusted) {
			return {
				ok: false,
				message: `A project_trust extension handler decides this folder is ${decided ? "trusted" : "untrusted"}; nothing was saved.`,
				errorCode: RPC_ERROR_PROJECT_TRUST_EXTENSION_DECIDED,
			};
		}
		new ProjectTrustStore(session.agentDir).setMany(selected.option.updates);
		const trusted = requiresTrust ? selected.option.trusted : true;
		if (settings.isProjectTrusted() !== trusted) {
			settings.setProjectTrusted(trusted);
			await session.applyProjectTrustChange();
		}
		return { ok: true, data: await readProjectTrust(session) };
	});
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
	// Decided synchronously right before the write starts: nothing can change the decision in between.
	const refusal = refuseProjectSettingWrite(session, key, value);
	if (refusal !== undefined) return { ok: false, ...refusal };
	try {
		await settings.setProjectSetting(key, value);
	} catch (error) {
		return {
			ok: false,
			message: `Writing ${file.path} failed: ${error instanceof Error ? error.message : String(error)}`,
			errorCode: RPC_ERROR_PROJECT_SETTINGS_WRITE_FAILED,
		};
	}
	return { ok: true, data: readProjectSettings(session) };
}
