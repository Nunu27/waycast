import type { Server } from "socket.io";
import type { WaycastAdapter } from "../../src/index.ts";

export function createSocketIOAdapter(io: Server): WaycastAdapter {
	return {
		subscribe(connectionId, topic) {
			io.sockets.sockets.get(connectionId)?.join(topic);
		},
		unsubscribe(connectionId, topic) {
			io.sockets.sockets.get(connectionId)?.leave(topic);
		},
		publish(topic, raw) {
			io.to(topic).emit("message", raw);
		},
		// socket.io already delivered to every subscriber in publish() above,
		// so there's nothing left for Waycast core to fan out here
		onMessage() {},
	};
}
