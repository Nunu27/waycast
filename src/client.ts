import type { Static, TSchema } from "typebox";
import {
	type BuiltInRpcRoutes,
	buildDataTopic,
	buildReplyTopic,
	type Router,
} from "./router";
import type {
	ClientAdapters,
	DataMessage,
	ParamsOf,
	RpcCallbacks,
	RpcDef,
	RpcReplyMessage,
} from "./types";

export class ClientApp<
	DataRoutes extends Record<string, TSchema>,
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> {
	private dataListeners = new Map<string, Set<(data: any) => void>>();
	private rpcCallbacks = new Map<string, RpcCallbacks<any>>();
	private dataRouteRefCounts = new Map<string, number>();

	constructor(
		_router: Router<any, DataRoutes, RpcRoutes>,
		private adapters: ClientAdapters<RpcRoutes & any>,
	) {}

	rpc<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		params: ParamsOf<Name>,
		payload: Static<RpcRoutes[Name]["payload"]>,
		callbacks: RpcCallbacks<RpcRoutes[Name]>,
	): () => void {
		let active = true;
		let assignedReplyTopic: string | undefined;

		const res = this.adapters.send({ name, params, payload } as any);
		Promise.resolve(res).then((replyTopic) => {
			if (!active) return;
			if (replyTopic) {
				assignedReplyTopic = replyTopic;
				this.rpcCallbacks.set(replyTopic, callbacks as any);
			}
		});

		return () => {
			active = false;
			if (assignedReplyTopic) {
				this.rpcCallbacks.delete(assignedReplyTopic);
			}
		};
	}

	subscribe(topics: string[]) {
		this.adapters.send({
			name: "_waycast:subscribe",
			params: undefined,
			payload: { topics },
		} as any);
	}

	unsubscribe(topics: string[]) {
		this.adapters.send({
			name: "_waycast:unsubscribe",
			params: undefined,
			payload: { topics },
		} as any);
	}

	resubscribe() {
		const activeTopics = Array.from(this.dataListeners.keys());
		if (activeTopics.length > 0) {
			this.subscribe(activeTopics);
		}
	}

	clear() {
		const activeTopics = Array.from(this.dataListeners.keys());
		if (activeTopics.length > 0) {
			this.unsubscribe(activeTopics);
		}
		this.dataListeners.clear();
		this.dataRouteRefCounts.clear();
		this.rpcCallbacks.clear();
	}

	onData<Name extends Extract<keyof DataRoutes, string>>(
		name: Name,
		params: ParamsOf<Name>,
		callback: (data: Static<DataRoutes[Name]>) => void,
	): () => void {
		const topic = buildDataTopic(name, params as any);
		if (!this.dataListeners.has(topic)) {
			this.dataListeners.set(topic, new Set());
		}
		this.dataListeners.get(topic)?.add(callback);

		const refCount = this.dataRouteRefCounts.get(topic) || 0;
		if (refCount === 0) {
			this.subscribe([topic]);
		}
		this.dataRouteRefCounts.set(topic, refCount + 1);

		return () => {
			const listeners = this.dataListeners.get(topic);
			if (listeners) {
				listeners.delete(callback);
				if (listeners.size === 0) {
					this.dataListeners.delete(topic);
				}
			}

			const newCount = (this.dataRouteRefCounts.get(topic) || 1) - 1;
			if (newCount <= 0) {
				this.unsubscribe([topic]);
				this.dataRouteRefCounts.delete(topic);
			} else {
				this.dataRouteRefCounts.set(topic, newCount);
			}
		};
	}

	handleData(message: DataMessage<DataRoutes>) {
		const topic = message.topic;
		const listeners = this.dataListeners.get(topic);
		if (listeners) {
			for (const cb of listeners) {
				cb(message.data);
			}
		}
	}

	handleReply(message: RpcReplyMessage<RpcRoutes & BuiltInRpcRoutes>) {
		const { name, requestId, reply } = message;
		const replyTopic = buildReplyTopic(name, requestId);
		const callbacks = this.rpcCallbacks.get(replyTopic);
		if (callbacks) {
			const cb = (callbacks as any)[reply.type];
			if (cb) {
				cb(reply.data);
			}

			if (reply.type === "response" || reply.type === "error") {
				this.rpcCallbacks.delete(replyTopic);
			}
		}
	}
}
