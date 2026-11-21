/**
 * Builds the startup warning for recommended tmux settings.
 *
 * All missing settings are collected into a single message so users can fix
 * ~/.tmux.conf once, instead of discovering the recommendations one tmux
 * restart at a time.
 */

export interface TmuxSetupCheck {
	/** Value of `tmux show -gv extended-keys`. */
	extendedKeys?: string;
	/** Value of `tmux show -gv extended-keys-format`. */
	extendedKeysFormat?: string;
	/** Whether Kitty images are already flowing through tmux passthrough. */
	imagesEnabled: boolean;
	/** Whether the terminal hosting the tmux client can render Kitty graphics. */
	outerKittyCapable: boolean;
	allowPassthrough?: string;
	focusEvents?: string;
	version?: string;
}

interface TmuxRecommendation {
	setting: string;
	reason: string;
}

export function buildTmuxSetupWarning(check: TmuxSetupCheck): string | undefined {
	const recommendations: TmuxRecommendation[] = [];

	// Real tmux always prints on/off/always. An empty read means the multiplexer does not register the
	// option at all (psmux 3.4), so setting it cannot change anything and recommending it never clears.
	if (check.extendedKeys !== "" && check.extendedKeys !== "on" && check.extendedKeys !== "always") {
		recommendations.push({
			setting: "set -g extended-keys on",
			reason: "modified Enter keys (Shift+Enter, ...)",
		});
	}

	if (check.extendedKeysFormat === "xterm") {
		recommendations.push({
			setting: "set -g extended-keys-format csi-u",
			reason: "Pi works best with csi-u",
		});
	}

	// Only advertise passthrough when it would actually do something: images
	// are not already enabled and the outer terminal understands Kitty
	// graphics. Users who deliberately chose `allow-passthrough on` already
	// have working images and are not nagged to switch to `all`.
	if (!check.imagesEnabled && check.outerKittyCapable) {
		const versionMatch = check.version?.match(/^(\d+)\.(\d+)/);
		const major = Number(versionMatch?.[1] ?? 0);
		const minor = Number(versionMatch?.[2] ?? 0);
		if (check.version && (major < 3 || (major === 3 && minor < 3))) {
			recommendations.push({
				setting: `upgrade tmux (current ${check.version})`,
				reason: "inline images need tmux >= 3.3",
			});
		} else {
			if (!["1", "on", "all"].includes(check.allowPassthrough ?? "")) {
				recommendations.push({
					setting: "set -g allow-passthrough on",
					reason: "inline images (Kitty graphics)",
				});
			}
			if (!["1", "on"].includes(check.focusEvents ?? "")) {
				recommendations.push({
					setting: "set -g focus-events on",
					reason: "repaint images after pane activation",
				});
			}
		}
	}

	if (recommendations.length === 0) {
		return undefined;
	}

	const settingWidth = Math.max(...recommendations.map((entry) => entry.setting.length));
	const lines = recommendations.map((entry) => `  ${entry.setting.padEnd(settingWidth)}  # ${entry.reason}`);
	return `tmux is not fully configured. Add to ~/.tmux.conf and restart tmux:\n\n${lines.join("\n")}`;
}
