import { startChatGptCallback } from "../../src/auth/oauth/chatgpt-subscription-callback.ts";

const port = Number(process.argv[2]);
const holder = await startChatGptCallback({
	host: "127.0.0.1",
	state: "holder-state",
	signal: new AbortController().signal,
	ports: [port],
});
if (!holder) process.exit(2);
process.stdout.write("listening\n");
await holder.server.wait();
setInterval(() => {}, 60_000);
