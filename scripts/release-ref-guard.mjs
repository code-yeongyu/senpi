/**
 * The in-code lock behind publish-npm.yml's main-only step conditions (senpi#6645 review). Inside GitHub Actions a run
 * that is not a dry run may stamp, tag, push or publish only when it was dispatched on refs/heads/main: a dispatch on
 * any other ref runs that ref's workflow file with the release job's id-token and, for the release step, possibly a
 * push token. A missing GITHUB_REF counts as "not main". Outside GitHub Actions (GITHUB_ACTIONS unset) the lock is
 * off, so local releases and their tests keep working; a local live publish is refused anyway (publish-command.mjs).
 */

const MAIN_REF = "refs/heads/main";

/**
 * @param {{dryRun: boolean, env: Record<string, string|undefined>, what: string}} input
 */
export function assertLiveRunOnMain({ dryRun, env, what }) {
	if (dryRun || env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF === MAIN_REF) return;
	throw new Error(
		`${what} runs live only from ${MAIN_REF}; this run was dispatched on ${env.GITHUB_REF ?? "an unknown ref"}. Dispatch on main, or pass a dry run`,
	);
}
