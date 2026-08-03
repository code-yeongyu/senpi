import { rulesForPreset } from "./config.ts";
import type { PermissionService } from "./service.ts";
import type { PermissionPresetName } from "./types.ts";

type ApprovalMode = Exclude<PermissionPresetName, "full-access">;

type ApprovalModeUI = {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
};

function nextMode(current: PermissionPresetName | undefined): ApprovalMode {
	switch (current) {
		case "workspace":
			return "read-only";
		case "read-only":
			return "ask";
		case "ask":
			return "workspace";
		default:
			return "workspace";
	}
}

/** Owns the active approval preset for one running session. */
export class ApprovalModeCycle {
	private current: PermissionPresetName | undefined;
	private readonly service: PermissionService;
	private readonly ui: ApprovalModeUI;

	constructor(service: PermissionService, initialPreset: PermissionPresetName | undefined, ui: ApprovalModeUI) {
		this.service = service;
		this.current = initialPreset;
		this.ui = ui;
	}

	next(): ApprovalMode {
		const mode = nextMode(this.current);
		this.current = mode;
		this.service.setSessionPreset(rulesForPreset(mode));
		this.ui.setStatus("approval-mode", `approval: ${mode}`);
		this.ui.notify(`Approval mode: ${mode}`, "info");
		return mode;
	}
}
