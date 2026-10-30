export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // skill name, command/tool/flag name, prompt name, theme name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	/** Optional for existing SDK resource overrides; skill loaders classify at the source. */
	kind?: "collision" | "parse-error" | "read-error" | "validation";
	category?: "size-limit" | "skill-link-blocked";
	message: string;
	hint?: string;
	path?: string;
	collision?: ResourceCollision;
}
