export type Action = "allow" | "deny" | "ask";

export type Rule = {
	permission: string;
	pattern: string;
	action: Action;
};

export type Ruleset = Rule[];

export type PermissionConfig = Record<string, Action | Record<string, Action>>;
