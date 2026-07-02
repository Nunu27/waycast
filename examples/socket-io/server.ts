import { Server } from "socket.io";
import { router } from "../router.ts";
import { createSocketIOAdapter } from "./adapter.ts";
import { createSocketIOServerTransport } from "./transport.ts";

const PORT = 8081;

const io = new Server(PORT);

const server = router.buildServer({
	transport: createSocketIOServerTransport(io, async () => undefined),
	adapter: createSocketIOAdapter(io),
	logger: console,
});

server.on("echo", async ({ payload, reply }) => {
	reply("info", `received: ${payload.message}`);
	return payload.message;
});

console.log(`waycast socket.io example listening on http://localhost:${PORT}`);

setInterval(() => {
	server.emit("room:[id]:messages", {
		params: { id: "lobby" },
		data: "hello from the server",
	});
}, 2000);
