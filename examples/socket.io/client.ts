import { io, type Socket } from "socket.io-client";
import type {
	BuiltInRpcRoutes,
	DataMessage,
	InferDataRoutes,
	InferRpcRoutes,
	RequestMessage,
	RpcReplyMessage,
} from "../../src";
import { type AppRouter, appRouter } from "./router";

type MyDataRoutes = InferDataRoutes<AppRouter>;
type MyRpcRoutes = InferRpcRoutes<AppRouter> & BuiltInRpcRoutes;

interface ClientToServerEvents {
	rpc: (message: RequestMessage<MyRpcRoutes>) => void;
}

interface ServerToClientEvents {
	data: (message: DataMessage<MyDataRoutes>) => void;
	reply: (message: RpcReplyMessage<MyRpcRoutes>) => void;
}

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
	"http://localhost:3000",
);

const client = appRouter.buildClient({
	send: (message) => {
		socket.emit("rpc", message);
	},
});

socket.on("data", (message) => {
	client.handleData(message);
});

socket.on("reply", (message) => {
	client.handleReply(message);
});

socket.on("connect", () => {
	console.log("Connected to server!");

	// Resubscribe to topics if this is a reconnection
	client.resubscribe();

	// 1. Subscribe to a data stream
	// Waycast automatically dispatches the underlying subscribe RPC for you!
	client.onData("system:alerts", {
		callback: (msg) => {
			console.log(`[Alert] ${msg}`);
		},
	});

	// You can also listen to topics that don't have payloads
	client.onData("system:ping", {
		callback: () => {
			console.log(`[Ping] Received ping from server!`);
		},
	});

	// 2. Perform a long-running RPC
	console.log("Starting job...");
	const _unsubscribe = client.rpc("job:[jobId]:process", {
		params: { jobId: "backup" },
		payload: { force: true },
		callbacks: {
			log: (msg) => console.log(`[Log] ${msg}`),
			progress: (p) => console.log(`[Progress] ${p.percent}%`),
			response: (res) => {
				console.log(`[Success] ${res}`);
				process.exit(0);
			},
			error: (err) => console.error(`[Error]`, err),
		},
	});

	// 3. Test disposing/aborting by disconnecting halfway!
	if (process.argv.includes("--abort")) {
		setTimeout(() => {
			console.log("Simulating disconnect to abort the job...");
			socket.disconnect();
			setTimeout(() => process.exit(0), 500); // Give it time to flush output
		}, 1200);
	}
});
socket.on("disconnect", () => {
	console.log("Disconnected from server!");
	client.handleDisconnect();
});
