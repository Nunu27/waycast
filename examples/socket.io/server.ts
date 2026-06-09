import { Server } from "socket.io";
import type {
	BuiltInRpcRoutes,
	DataMessage,
	InferDataRoutes,
	InferRpcRoutes,
	RequestMessage,
	RpcReplyMessage,
} from "../../src";
import { type AppRouter, appRouter, type Context } from "./router";

type MyDataRoutes = InferDataRoutes<AppRouter>;
type MyRpcRoutes = InferRpcRoutes<AppRouter> & BuiltInRpcRoutes;

interface ClientToServerEvents {
	rpc: (
		message: RequestMessage<MyRpcRoutes>,
		ack: (requestId: string) => void,
	) => void;
}

interface ServerToClientEvents {
	data: (message: DataMessage<MyDataRoutes>) => void;
	reply: (message: RpcReplyMessage<MyRpcRoutes>) => void;
}

const io = new Server<ClientToServerEvents, ServerToClientEvents>(3000);

const server = appRouter.buildServer<Context>({
	topic: {
		subscribe: (connectionId, ...topics) => {
			const socket = io.sockets.sockets.get(connectionId);
			if (socket) {
				socket.join(topics);
			}
		},
		unsubscribe: (connectionId, ...topics) => {
			const socket = io.sockets.sockets.get(connectionId);
			if (socket) {
				topics.forEach((t) => {
					socket.leave(t);
				});
			}
		},
	},
	emit: (topic, message) => {
		io.to(topic).emit("data", message);
	},
	reply: (topic, message) => {
		io.to(topic).emit("reply", message);
	},
});

server
	.on("job:[jobId]:process", async (ctx) => {
		const { jobId } = ctx.params;
		const { force } = ctx.payload;

		if (!ctx.context.userId) {
			throw new Error("Unauthorized");
		}

		ctx.reply("log", `Job ${jobId} started (force: ${force})`);

		for (let i = 1; i <= 5; i++) {
			await new Promise((r) => setTimeout(r, 500));
			ctx.reply("progress", { percent: i * 20 });
		}

		return true;
	})
	.onDispose("job:[jobId]:process", (requestId) => {
		console.log(
			`[Dispose] Request ${requestId} was aborted because the client disconnected!`,
		);
	});

io.of("/").adapter.on("leave-room", (room, _id) => {
	if (room.endsWith(":reply")) {
		server.handleDispose(room);
	}
});

io.on("connection", (socket) => {
	console.log(`Client connected: ${socket.id}`);

	socket.on("rpc", (message, ack) => {
		const requestId = Math.random().toString(36).slice(2);
		if (ack) ack(requestId);

		// We inject the socket id and build the context
		server.handle(socket.id, requestId, message, async (_meta) => {
			return { userId: "user-123" };
		});
	});

	socket.on("disconnect", () => {
		console.log(`Client disconnected: ${socket.id}`);
	});
});

console.log("Socket.io server listening on port 3000");

setInterval(() => {
	server.emit("system:alerts", undefined, "Server is healthy!");
}, 2000);
