import type {
	TArray,
	TObject,
	TSchema,
	TString,
	TVoid,
} from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ClientApp } from "./client";
import { ServerApp } from "./server";
import type {
	CheckMeta,
	ClientAdapters,
	Prettify,
	RpcDef,
	ServerAdapters,
} from "./types";

export type BuiltInRpcRoutes = {
	"_waycast:subscribe": RpcDef<
		TObject<{ topics: TArray<TString> }>,
		{},
		TVoid,
		any
	>;
	"_waycast:unsubscribe": RpcDef<
		TObject<{ topics: TArray<TString> }>,
		{},
		TVoid,
		any
	>;
};

export interface RouterOptions {
	maxDisconnectionDuration?: number;
}

export class Router<
	Meta,
	DataRoutes extends Record<string, TSchema> = {},
	RpcRoutes extends Record<string, RpcDef<any, any, any, Meta>> = {},
> {
	public _dataRoutes: Record<string, any> = {};
	public _rpcRoutes: Record<string, any> = {
		"_waycast:subscribe": {
			payload: Type.Object({ topics: Type.Array(Type.String()) }),
			replies: {},
			response: Type.Void(),
			meta: {},
		},
		"_waycast:unsubscribe": {
			payload: Type.Object({ topics: Type.Array(Type.String()) }),
			replies: {},
			response: Type.Void(),
			meta: {},
		},
	};

	constructor(public options: RouterOptions = {}) {}

	data<Name extends string, Schema extends TSchema>(
		name: Name,
		schema: Schema,
	): Router<Meta, DataRoutes & { [K in Name]: Schema }, RpcRoutes> {
		this._dataRoutes[name] = schema;
		return this as unknown as Router<
			Meta,
			DataRoutes & { [K in Name]: Schema },
			RpcRoutes
		>;
	}

	rpc<
		Name extends string,
		Payload extends TSchema,
		Replies extends Record<string, TSchema> = {},
		Response extends TSchema = TVoid,
	>(
		name: Name,
		def: Prettify<
			{
				payload: Payload;
				replies?: Replies;
				response?: Response;
			} & CheckMeta<Meta>
		>,
	): Router<
		Meta,
		DataRoutes,
		RpcRoutes & { [K in Name]: RpcDef<Payload, Replies, Response, Meta> }
	> {
		this._rpcRoutes[name] = {
			payload: def.payload,
			replies: def.replies ?? {},
			response: def.response ?? Type.Void(),
			meta: def.meta as Meta,
		};
		return this as unknown as Router<
			Meta,
			DataRoutes,
			RpcRoutes & { [K in Name]: RpcDef<Payload, Replies, Response, Meta> }
		>;
	}

	merge<
		OtherData extends Record<string, TSchema>,
		OtherRpc extends Record<string, RpcDef<any, any, any, Meta>>,
	>(
		other: Router<Meta, OtherData, OtherRpc>,
	): Router<Meta, DataRoutes & OtherData, RpcRoutes & OtherRpc> {
		this._dataRoutes = { ...this._dataRoutes, ...other._dataRoutes };
		this._rpcRoutes = { ...this._rpcRoutes, ...other._rpcRoutes };
		this.options = { ...this.options, ...other.options };
		return this as unknown as Router<
			Meta,
			DataRoutes & OtherData,
			RpcRoutes & OtherRpc
		>;
	}

	_getRpcRoute<K extends keyof RpcRoutes>(name: K): RpcRoutes[K] {
		return this._rpcRoutes[name as string] as RpcRoutes[K];
	}

	buildServer<Context = {}>(
		adapters: ServerAdapters<DataRoutes, RpcRoutes & BuiltInRpcRoutes>,
	): ServerApp<Context, Meta, DataRoutes, RpcRoutes> {
		return new ServerApp(this, adapters);
	}

	buildClient(
		adapters: ClientAdapters<RpcRoutes & BuiltInRpcRoutes>,
	): ClientApp<DataRoutes, RpcRoutes> {
		return new ClientApp(this, adapters);
	}
}

export type InferDataRoutes<T> =
	T extends Router<any, infer D, any> ? D : never;
export type InferRpcRoutes<T> = T extends Router<any, any, infer R> ? R : never;

export const buildDataTopic = (
	name: string,
	params?: Record<string, string>,
) => {
	if (!params) return name;
	let topic = name;
	for (const [key, value] of Object.entries(params)) {
		topic = topic.replace(`[${key}]`, value);
	}
	return topic;
};

export const buildReplyTopic = (name: string, requestId: string) =>
	`${name}|${requestId}|reply`;
