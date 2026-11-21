import type { TmuxDetectedState, TmuxImageState } from "./tmux-image-probe.ts";

export type TmuxKittyTerminal = "kitty" | "ghostty" | "warp" | "rex";
export type TmuxKittyPlacement = "placeholder" | "direct";
export type TmuxKittyTerminalOverride = TmuxKittyTerminal | undefined;

export function isRexTermName(termname: string): boolean {
	const term = termname.trim().toLowerCase();
	return term === "rex" || term === "xterm-rex" || term.startsWith("xterm-rex-");
}

export type TmuxImageDisabledReason =
	| "outside-tmux"
	| "probe-unavailable"
	| "unsupported-version"
	| "passthrough-off"
	| "focus-events-off"
	| "multiple-clients"
	| "nested"
	| "hidden"
	| "unknown-client"
	| "unsafe-direct-placement";

export type TmuxImageDecision =
	| {
			readonly enabled: true;
			readonly placement: TmuxKittyPlacement;
			readonly terminal: TmuxKittyTerminal;
	  }
	| { readonly enabled: false; readonly reason: TmuxImageDisabledReason };

interface TmuxKittyIdentity {
	readonly placement: TmuxKittyPlacement;
	readonly terminal: TmuxKittyTerminal;
}

export function parseTmuxKittyTerminalOverride(raw: string | undefined): TmuxKittyTerminalOverride {
	return raw === "kitty" || raw === "ghostty" || raw === "warp" || raw === "rex" ? raw : undefined;
}

function identityForTerminal(terminal: TmuxKittyTerminal): TmuxKittyIdentity {
	return {
		terminal,
		placement: terminal === "warp" ? "direct" : "placeholder",
	};
}

function identifyTmuxKittyClient(
	clientTermname: string,
	override: TmuxKittyTerminalOverride,
): TmuxKittyIdentity | null {
	if (override) return identityForTerminal(override);
	const term = clientTermname.trim().toLowerCase();
	if (term.includes("kitty")) return identityForTerminal("kitty");
	if (term.includes("ghostty")) return identityForTerminal("ghostty");
	if (term.includes("warp")) return identityForTerminal("warp");
	if (isRexTermName(term)) return identityForTerminal("rex");
	return null;
}

function topologyReason(state: TmuxDetectedState): TmuxImageDisabledReason | null {
	if (state.supportTier === "unsupported") return "unsupported-version";
	if (state.nested) return "nested";
	if (state.clientCount !== 1) return "multiple-clients";
	if (!state.focusEvents) return "focus-events-off";
	if (state.allowPassthrough === "off") return "passthrough-off";
	return null;
}

export function canTrackTmuxImageFocus(state: TmuxImageState, override: TmuxKittyTerminalOverride): boolean {
	if (state.kind !== "tmux" || topologyReason(state)) return false;
	const identity = identifyTmuxKittyClient(state.clientTermname, override);
	if (!identity) return false;
	return identity.placement !== "direct" || state.allowPassthrough === "on";
}

export function decideTmuxImageCapability(
	state: TmuxImageState,
	override: TmuxKittyTerminalOverride,
): TmuxImageDecision {
	if (state.kind === "outside") return { enabled: false, reason: "outside-tmux" };
	if (state.kind === "unavailable") return { enabled: false, reason: "probe-unavailable" };

	const topology = topologyReason(state);
	if (topology) return { enabled: false, reason: topology };
	if (!state.visible) return { enabled: false, reason: "hidden" };

	const identity = identifyTmuxKittyClient(state.clientTermname, override);
	if (!identity) return { enabled: false, reason: "unknown-client" };
	if (identity.placement === "direct" && state.allowPassthrough !== "on") {
		return { enabled: false, reason: "unsafe-direct-placement" };
	}
	return { enabled: true, placement: identity.placement, terminal: identity.terminal };
}
