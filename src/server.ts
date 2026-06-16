import type { Static, TSchema } from "@sinclair/typebox";
import { type TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler";
import {
	type BuiltInRpcRoutes,
	buildDataTopic,
	buildReplyTopic,
	type Router,
} from "./router";
import type {
	MaybePromise,
	ParamsOf,
	Prettify,
	RequestMessage,
	RpcDef,
	ServerAdapters,
	WithParams,
} from "./types";

export type RpcContext<
	P,
	Context,
	Payload,
	Replies extends Record<string, TSchema>,
> = Prettify<{
	connectionId: string;
	requestId: string;
	params: P;
	context: Context;
	payload: Payload;
	reply: <K extends Extract<keyof Replies, string>>(
		type: K,
		data: Static<Replies[K]>,
	) => void;
}>;

export const DEFER = "__waycast_defer__" as const;

export type Handler<
	P,
	Context,
	Payload,
	Response,
	Replies extends Record<string, TSchema>,
> = (
	ctx: RpcContext<P, Context, Payload, Replies>,
) => MaybePromise<Response | typeof DEFER>;

export class ServerApp<
	Context,
	Meta,
	DataRoutes extends Record<string, TSchema>,
	RpcRoutes extends Record<string, RpcDef<any, any, any, Meta>>,
> {
	public readonly defer = DEFER;
	private handlers = new Map<string, Handler<any, any, any, any, any>>();
	private disposeHandlers = new Map<
		string,
		(connectionId: string, requestId: string) => MaybePromise<void>
	>();

	private pendingDisposals = new Map<string, NodeJS.Timeout>();
	private compiledPayloads = new Map<string, TypeCheck<any>>();

	constructor(
		private router: Router<Meta, DataRoutes, RpcRoutes>,
		private adapters: ServerAdapters<DataRoutes, RpcRoutes & any>,
	) {
		for (const [name, route] of Object.entries(this.router._rpcRoutes)) {
			try {
				this.compiledPayloads.set(name, TypeCompiler.Compile(route.payload));
			} catch (e) {
				this.adapters.logger?.warn(
					{ error: e },
					`Failed to compile schema for route ${name}:`,
				);
			}
		}

		if (!this.adapters.disposal) {
			this.adapters.disposal = {
				schedule: (connectionId, topic, duration) => {
					this.adapters.disposal?.cancel(topic);
					this.pendingDisposals.set(
						topic,
						setTimeout(() => {
							this.executeDispose(connectionId, topic);
						}, duration),
					);
				},
				cancel: (topic) => {
					const existing = this.pendingDisposals.get(topic);
					if (existing) {
						clearTimeout(existing);
						this.pendingDisposals.delete(topic);
					}
				},
			};
		}
	}

	on<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		handler: Handler<
			ParamsOf<Name>,
			Context,
			Static<RpcRoutes[Name]["payload"]>,
			Static<RpcRoutes[Name]["response"]>,
			RpcRoutes[Name]["replies"]
		>,
	) {
		if (this.handlers.has(name)) {
			this.adapters.logger?.warn?.({ name }, "Overriding existing RPC handler");
		}
		this.handlers.set(name, handler as Handler<any, any, any, any, any>);
		return this;
	}

	onDispose<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		handler: (connectionId: string, requestId: string) => MaybePromise<void>,
	) {
		if (this.disposeHandlers.has(name)) {
			this.adapters.logger?.warn?.(
				{ name },
				"Overriding existing dispose handler",
			);
		}
		this.disposeHandlers.set(name, handler);
		return this;
	}

	#isReplyTopic(topic: string) {
		return topic.endsWith("|reply");
	}

	#getReplyInfo(topic: string) {
		if (!this.#isReplyTopic(topic)) return;

		const parts = topic.split("|");
		if (parts.length < 3) return;

		const requestId = parts[parts.length - 2];
		if (!requestId) return;
		const name = parts.slice(0, parts.length - 2).join("|");

		return { name, requestId };
	}

	async handleUnsubscribe(connectionId: string, topic: string) {
		const info = this.#getReplyInfo(topic);
		if (!info) return;

		const handler = this.disposeHandlers.get(info.name);
		if (!handler) return;

		this.adapters.logger?.debug?.(
			{ connectionId, topic, ...info },
			"Handling unsubscribe / cleanup for reply topic",
		);

		try {
			const isConnected = await this.adapters.isClientConnected?.(connectionId);
			const maxDuration = this.router.options.maxDisconnectionDuration;

			if (isConnected === false && maxDuration !== undefined) {
				this.adapters.disposal?.schedule(connectionId, topic, maxDuration);
			} else {
				await this.executeDispose(connectionId, topic);
			}
		} catch (error) {
			this.adapters.logger?.error(
				{ error },
				`Error in onDispose handler for ${info.name}:`,
			);
		}
	}

	async executeDispose(connectionId: string, topic: string) {
		const info = this.#getReplyInfo(topic);
		if (!info) return;

		const handler = this.disposeHandlers.get(info.name);
		if (!handler) return;

		this.adapters.logger?.debug?.(
			{ topic, ...info },
			"Executing dispose / cleanup for reply topic",
		);
		try {
			await handler(connectionId, info.requestId);
		} catch (error) {
			this.adapters.logger?.error(
				{ error },
				`Error in delayed onDispose handler for ${info.name}:`,
			);
		}
	}

	async handle(
		connectionId: string,
		message: RequestMessage<RpcRoutes & BuiltInRpcRoutes>,
		middleware?: (meta?: Meta) => MaybePromise<Context>,
	) {
		const { name, params, payload, requestId } = message;
		const replyTopic = buildReplyTopic(name, requestId);

		this.adapters.logger?.debug?.(
			{ connectionId, name, requestId, params, payload },
			"Received RPC request on server",
		);

		try {
			const compiler = this.compiledPayloads.get(name);
			if (compiler && !compiler.Check(payload)) {
				const errors = [...compiler.Errors(payload)];
				throw new Error(
					`Invalid payload for ${name}: ${JSON.stringify(errors)}`,
				);
			}

			if (name === "_waycast:subscribe" || name === "_waycast:unsubscribe") {
				const topics = (payload as { topics?: string[] })?.topics;
				if (!Array.isArray(topics)) return;

				if (name === "_waycast:subscribe") {
					this.adapters.topic?.subscribe(connectionId, ...topics);
					for (const topic of topics) {
						if (!this.#isReplyTopic(topic)) continue;
						await this.adapters.disposal?.cancel(topic);
					}
				} else {
					this.adapters.topic?.unsubscribe(connectionId, ...topics);
				}

				return;
			}

			this.adapters.topic?.subscribe(connectionId, replyTopic);

			const handler = this.handlers.get(name);
			if (!handler) {
				throw new Error(`No handler found for RPC route: ${name}`);
			}

			const rpcDef = this.router._getRpcRoute(name);
			let context: Context;

			if (middleware) {
				context = await middleware(rpcDef.meta);
			} else {
				context = {} as Context;
			}

			const ctx: RpcContext<any, any, any, any> = {
				connectionId,
				requestId,
				params,
				context,
				payload,
				reply: (type, data) => {
					this.adapters.logger?.debug?.(
						{ connectionId, name, requestId, replyTopic, type, data },
						"Sending RPC intermediate reply",
					);
					this.adapters.reply(replyTopic, {
						name,
						requestId,
						reply: { type, data },
					});
				},
			};

			const response = await handler(ctx);
			this.adapters.logger?.debug?.(
				{ connectionId, name, requestId, responseDeferred: response === DEFER },
				"RPC route handler completed",
			);
			if (response !== DEFER) {
				this.adapters.reply(replyTopic, {
					name,
					requestId,
					reply: { type: "response", data: response },
				});
			}
		} catch (error) {
			this.adapters.logger?.error(
				{ error },
				`Error handling RPC route ${name}:`,
			);
			this.adapters.topic?.unsubscribe(connectionId, replyTopic);
			this.adapters.reply(replyTopic, {
				name,
				requestId,
				reply: {
					type: "error",
					data:
						this.adapters.errorFormatter?.(error) ??
						(error instanceof Error ? error.message : String(error)),
				},
			});
		}
	}

	emit<Name extends Extract<keyof DataRoutes, string>>(
		name: Name,
		options: WithParams<
			ParamsOf<Name>,
			{
				data: Static<DataRoutes[Name]>;
			}
		>,
	) {
		const { params, data } = options;
		const topic = buildDataTopic(name, params);
		this.adapters.logger?.debug?.(
			{ name, params, topic, data },
			"Emitting data event",
		);
		this.adapters.emit(topic, { name, topic, data });
	}

	reply<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		requestId: string,
	) {
		return <K extends Extract<keyof RpcRoutes[Name]["replies"], string>>(
			type: K,
			data: Static<RpcRoutes[Name]["replies"][K]>,
		) => {
			const replyTopic = buildReplyTopic(name, requestId);
			this.adapters.logger?.debug?.(
				{ name, requestId, replyTopic, type, data },
				"Sending RPC intermediate reply (standalone)",
			);
			this.adapters.reply(replyTopic, {
				name,
				requestId,
				reply: { type, data },
			});
		};
	}

	replyResponse<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		requestId: string,
		data: Static<RpcRoutes[Name]["response"]>,
	) {
		const replyTopic = buildReplyTopic(name, requestId);
		this.adapters.logger?.debug?.(
			{ name, requestId, replyTopic, data },
			"Sending RPC final response reply (standalone)",
		);
		this.adapters.reply(replyTopic, {
			name,
			requestId,
			reply: { type: "response", data },
		});
	}

	replyError<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		requestId: string,
		error: string,
	) {
		const replyTopic = buildReplyTopic(name, requestId);
		this.adapters.logger?.debug?.(
			{ name, requestId, replyTopic, error },
			"Sending RPC error reply (standalone)",
		);
		this.adapters.reply(replyTopic, {
			name,
			requestId,
			reply: { type: "error", data: error },
		});
	}
}
