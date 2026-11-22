/**
 * WezTerm on Windows runs its shell through the ConPTY it bundles. Bundled
 * ConPTY builds before 1.22 drop the Kitty graphics APC (`ESC _G ... ESC \`)
 * before it reaches WezTerm, so an image placement leaves a blank gap. WezTerm
 * bundled ConPTY 1.22.250204002 in wezterm/wezterm@4accc376f, whose version
 * string is below (committer date in its own zone, see wezterm-version/build.rs);
 * that build and later ones deliver the APC. No stable release has it yet.
 */
export const MIN_WEZTERM_WINDOWS_IMAGES_VERSION = "20250208-160106";

export const WEZTERM_WINDOWS_IMAGES_HINT = "update WezTerm to a nightly build to show images inline";

// WezTerm sets TERM_PROGRAM_VERSION to `wezterm_version()`: YYYYMMDD-HHMMSS-<commit>.
const WEZTERM_VERSION = /^(\d{8})-(\d{6})-[0-9a-f]+/i;

/**
 * True only when WezTerm on Windows positively reports a build older than the
 * first one whose bundled ConPTY passes Kitty graphics through. A missing or
 * unparsable version keeps images on: there is no evidence of an old build.
 */
export function isOldWindowsWezTerm(version: string | undefined, platform: NodeJS.Platform): boolean {
	if (platform !== "win32" || version === undefined) return false;
	const match = WEZTERM_VERSION.exec(version);
	if (!match) return false;
	return `${match[1]}-${match[2]}` < MIN_WEZTERM_WINDOWS_IMAGES_VERSION;
}
