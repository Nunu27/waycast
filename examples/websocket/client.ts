import { router } from "../router.ts";
import { createWebSocketClientTransport } from "./transport.ts";

const client = router.buildClient({
	transport: createWebSocketClientTransport("ws://localhost:8080"),
	logger: console,
});

client.onData("room:[id]:messages", {
	params: { id: "lobby" },
	callback: (data) => console.log("[room:lobby]", data),
});

client.rpc("echo", {
	payload: { message: "hello from the websocket example client" },
	callbacks: {
		info: (msg) => console.log("[info]", msg),
		response: (msg) => console.log("[response]", msg),
		error: (err) => console.error("[error]", err),
	},
});
