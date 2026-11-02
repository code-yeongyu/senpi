declare module "signal-exit" {
	function onExit(
		callback: (code: number | null, signal: NodeJS.Signals | null) => void,
		options?: { readonly alwaysLast?: boolean },
	): () => void;
	export default onExit;
}
