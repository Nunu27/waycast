import { router } from "../router.ts";
import { createWebSocketServerTransport } from "./transport.ts";

const PORT = 8080;

const server = router.buildServer({
	transport: createWebSocketServerTransport(PORT, async () => undefined),
	logger: console,
});

server.on("echo", async ({ payload, reply }) => {
	reply("info", `received: ${payload.message}`);
	return payload.message;
});

console.log(`waycast websocket example listening on ws://localhost:${PORT}`);

setInterval(() => {
	server.emit("room:[id]:messages", {
		params: { id: "lobby" },
		data: `tick ${new Date().toISOString()}`,
	});
}, 2000);
