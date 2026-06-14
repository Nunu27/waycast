import type { Static, TSchema } from "@sinclair/typebox";
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
	SendMessage,
} from "./types";

export class ClientApp<
	DataRoutes extends Record<string, TSchema>,
	RpcRoutes extends Record<string, RpcDef<any, any, any, any>>,
> {
	private dataListeners = new Map<string, Set<(data: any) => void>>();
	private rpcCallbacks = new Map<string, RpcCallbacks<any>>();
	private dataRouteRefCounts = new Map<string, number>();

	private disconnectedAt?: number;

	constructor(
		private router: Router<any, DataRoutes, RpcRoutes>,
		private adapters: ClientAdapters<RpcRoutes & BuiltInRpcRoutes>,
	) {}

	rpc<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		params: ParamsOf<Name>,
		payload: Static<RpcRoutes[Name]["payload"]>,
		callbacks: RpcCallbacks<RpcRoutes[Name]>,
	): () => void {
		const requestId = crypto.randomUUID();
		const assignedReplyTopic = buildReplyTopic(name, requestId);

		this.rpcCallbacks.set(assignedReplyTopic, callbacks);

		this.adapters.logger?.debug?.(
			{ requestId, name, params, payload, assignedReplyTopic },
			"Initiating RPC request",
		);

		const res = this.adapters.send({
			requestId,
			name,
			params,
			payload,
		} as unknown as SendMessage<RpcRoutes & BuiltInRpcRoutes>);
		Promise.resolve(res).catch((err) => {
			this.adapters.logger?.error?.({ err }, "Failed to send RPC message");
		});

		return () => {
			this.adapters.logger?.debug?.(
				{ requestId, name, assignedReplyTopic },
				"Cleaning up RPC request callbacks",
			);
			this.rpcCallbacks.delete(assignedReplyTopic);
			this.unsubscribe([assignedReplyTopic]);
		};
	}

	private pendingSubscribes = new Set<string>();
	private pendingUnsubscribes = new Set<string>();
	private flushScheduled = false;

	private scheduleFlush() {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		Promise.resolve().then(() => {
			this.flushScheduled = false;

			if (this.pendingSubscribes.size > 0) {
				const topics = Array.from(this.pendingSubscribes);
				this.pendingSubscribes.clear();
				this.adapters.logger?.debug?.({ topics }, "Sending subscribe request");
				this.adapters.send({
					requestId: crypto.randomUUID(),
					name: "_waycast:subscribe",
					params: undefined,
					payload: { topics },
				} as unknown as SendMessage<RpcRoutes & BuiltInRpcRoutes>);
			}

			if (this.pendingUnsubscribes.size > 0) {
				const topics = Array.from(this.pendingUnsubscribes);
				this.pendingUnsubscribes.clear();
				this.adapters.logger?.debug?.(
					{ topics },
					"Sending unsubscribe request",
				);
				this.adapters.send({
					requestId: crypto.randomUUID(),
					name: "_waycast:unsubscribe",
					params: undefined,
					payload: { topics },
				} as unknown as SendMessage<RpcRoutes & BuiltInRpcRoutes>);
			}
		});
	}

	subscribe(topics: string[]) {
		for (const topic of topics) {
			this.pendingUnsubscribes.delete(topic);
			this.pendingSubscribes.add(topic);
		}
		this.scheduleFlush();
	}

	unsubscribe(topics: string[]) {
		for (const topic of topics) {
			this.pendingSubscribes.delete(topic);
			this.pendingUnsubscribes.add(topic);
		}
		this.scheduleFlush();
	}

	handleDisconnect() {
		this.disconnectedAt = Date.now();
	}

	resubscribe() {
		let disconnectedDuration = 0;
		if (this.disconnectedAt) {
			disconnectedDuration = Date.now() - this.disconnectedAt;
			this.disconnectedAt = undefined;
		}

		const activeTopics = [...this.dataListeners.keys()];

		const maxDuration = this.router.options.maxDisconnectionDuration;
		if (maxDuration === undefined || disconnectedDuration <= maxDuration) {
			activeTopics.push(...this.rpcCallbacks.keys());
		} else {
			for (const [topic, callbacks] of this.rpcCallbacks.entries()) {
				callbacks.error?.("Connection lost for too long");
				this.rpcCallbacks.delete(topic);
			}
		}

		if (activeTopics.length > 0) {
			this.adapters.logger?.debug?.(
				{ activeTopics },
				"Triggering resubscription for active topics",
			);
			this.subscribe(activeTopics);
		}
	}

	clear() {
		const activeTopics = [
			...this.dataListeners.keys(),
			...this.rpcCallbacks.keys(),
		];
		this.adapters.logger?.debug?.(
			{ activeTopics, rpcCallbacksCount: this.rpcCallbacks.size },
			"Clearing all client active topics, listeners, and RPC callbacks",
		);
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
		const topic = buildDataTopic(name, params);
		if (!this.dataListeners.has(topic)) {
			this.dataListeners.set(topic, new Set());
		}
		this.dataListeners.get(topic)?.add(callback);

		const refCount = this.dataRouteRefCounts.get(topic) || 0;
		this.adapters.logger?.debug?.(
			{ name, params, topic, refCount: refCount + 1 },
			"Subscribing to data topic listener",
		);
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
			this.adapters.logger?.debug?.(
				{ name, params, topic, newCount },
				"Unsubscribing from data topic listener",
			);
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
		this.adapters.logger?.debug?.(
			{ topic, name: message.name, data: message.data },
			"Received data message",
		);
		const listeners = this.dataListeners.get(topic);
		if (listeners) {
			for (const cb of listeners) {
				cb(message.data);
			}
		} else {
			this.adapters.logger?.debug?.(
				{ topic, name: message.name },
				"No listeners registered for data topic",
			);
		}
	}

	handleReply(message: RpcReplyMessage<RpcRoutes & BuiltInRpcRoutes>) {
		const { name, requestId, reply } = message;
		const replyTopic = buildReplyTopic(name, requestId);
		this.adapters.logger?.debug?.(
			{
				name,
				requestId,
				replyTopic,
				replyType: reply.type,
				replyData: reply.data,
			},
			"Received RPC reply",
		);
		const callbacks = this.rpcCallbacks.get(replyTopic);
		if (callbacks) {
			callbacks[reply.type]?.(reply.data);

			if (reply.type === "error") {
				this.rpcCallbacks.delete(replyTopic);
			}
		} else {
			this.adapters.logger?.debug?.(
				{ name, requestId, replyTopic },
				"No callback found for reply topic",
			);
		}
	}
}
