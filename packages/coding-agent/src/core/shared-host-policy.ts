/** Shared host is OFF by default; interactive sessions opt in via env flag or the experimental setting. */
export function shouldJoinSharedHost(
	appMode: string,
	opts: { readonly enableEnv: boolean; readonly settingEnabled: boolean },
): boolean {
	if (appMode !== "interactive") return false;
	return opts.enableEnv || opts.settingEnabled;
}
