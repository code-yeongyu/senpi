export function buildPublishArgs({ githubActions }) {
	if (!githubActions) {
		throw new Error("GitHub Actions is required for provenance-backed npm publication.");
	}

	const args = ["publish", "--access", "public", "--tag", "latest"];
	args.push("--provenance");
	args.push("--ignore-scripts");
	return args;
}
