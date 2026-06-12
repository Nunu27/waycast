import type { Static, TSchema } from "@sinclair/typebox";
import { type TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler";
import {
	type BuiltInRpcRoutes,
	buildDataTopic,
	buildReplyTopic,
	type Router,
} from "./router";
import type {
	ParamsOf,
	Prettify,
	RequestMessage,
	RpcDef,
	ServerAdapters,
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

export type Handler<
	P,
	Context,
	Payload,
	Response,
	Replies extends Record<string, TSchema>,
> = (
	ctx: RpcContext<P, Context, Payload, Replies>,
) => Promise<Response> | Response;

export const DEFER = Symbol("waycast.defer");

export class ServerApp<
	Context,
	Meta,
	DataRoutes extends Record<string, TSchema>,
	RpcRoutes extends Record<string, RpcDef<any, any, any, Meta>>,
> {
	public readonly defer = DEFER as any;
	private handlers = new Map<string, Handler<any, any, any, any, any>>();
	private disposeHandlers = new Map<
		string,
		(connectionId: string, requestId: string) => void | Promise<void>
	>();

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
		this.handlers.set(name, handler as any);
		return this;
	}

	onDispose<Name extends Extract<keyof RpcRoutes, string>>(
		name: Name,
		handler: (connectionId: string, requestId: string) => void | Promise<void>,
	) {
		this.disposeHandlers.set(name, handler);
		return this;
	}

	async handleDispose(connectionId: string, topic: string) {
		if (!topic.endsWith("|reply")) return;
		const parts = topic.split("|");
		if (parts.length < 3) return;

		const requestId = parts[parts.length - 2];
		if (!requestId) return;
		const name = parts.slice(0, parts.length - 2).join("|");

		const handler = this.disposeHandlers.get(name);
		if (handler) {
			try {
				await handler(connectionId, requestId);
			} catch (error) {
				this.adapters.logger?.error(
					{ error },
					`Error in onDispose handler for ${name}:`,
				);
			}
		}
	}

	async handle(
		connectionId: string,
		requestId: string,
		message: RequestMessage<RpcRoutes & BuiltInRpcRoutes>,
		middleware?: (meta?: Meta) => Promise<Context> | Context,
	) {
		const { name, params, payload } = message;
		const replyTopic = buildReplyTopic(name, requestId);

		try {
			const compiler = this.compiledPayloads.get(name);
			if (compiler && !compiler.Check(payload)) {
				const errors = [...compiler.Errors(payload)];
				throw new Error(
					`Invalid payload for ${name}: ${JSON.stringify(errors)}`,
				);
			}

			this.adapters.topic?.subscribe(connectionId, replyTopic);

			if (name === "_waycast:subscribe" || name === "_waycast:unsubscribe") {
				const topics = (payload as any)?.topics as string[];
				if (Array.isArray(topics)) {
					if (name === "_waycast:subscribe") {
						this.adapters.topic?.subscribe(connectionId, ...topics);
					} else {
						this.adapters.topic?.unsubscribe(connectionId, ...topics);
					}
				}
				return;
			}

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
					this.adapters.reply(replyTopic, {
						name,
						requestId,
						reply: { type, data },
					});
				},
			};

			const response = await handler(ctx);
			if (response !== DEFER) {
				this.adapters.reply(replyTopic, {
					name,
					requestId,
					reply: { type: "response", data: response },
				});
			}
		} catch (error) {
			this.adapters.topic?.unsubscribe(connectionId, replyTopic);
			this.adapters.reply(replyTopic, {
				name,
				requestId,
				reply: { type: "error", data: error },
			});
		}
	}

	emit<Name extends Extract<keyof DataRoutes, string>>(
		name: Name,
		params: ParamsOf<Name>,
		data: Static<DataRoutes[Name]>,
	) {
		const topic = buildDataTopic(name, params);
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
		this.adapters.reply(replyTopic, {
			name,
			requestId,
			reply: { type: "error", data: error },
		});
	}
}
