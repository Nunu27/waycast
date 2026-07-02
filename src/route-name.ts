export type RouteParams<Name extends string> = string extends Name
	? Record<string, string>
	: Name extends `${string}[${infer Param}]${infer Rest}`
		? Record<Param, string> & RouteParams<Rest>
		: // biome-ignore lint/complexity/noBannedTypes: to not add additional keys to the record
			{};

// Makes `params` optional when the route has no `[param]` segments
export type ParamsArg<Name extends string> = [keyof RouteParams<Name>] extends [
	never,
]
	? { params?: RouteParams<Name> }
	: { params: RouteParams<Name> };

export interface CompiledRoute {
	regex: RegExp;
	paramNames: string[];
}

const PARAM_PATTERN = /\[([^[\]]+)]/g;
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
	return value.replace(REGEX_ESCAPE, "\\$&");
}

export function compileRoute(name: string): CompiledRoute {
	const paramNames: string[] = [];
	let pattern = "";
	let lastIndex = 0;

	PARAM_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null = PARAM_PATTERN.exec(name);
	while (match !== null) {
		pattern += escapeRegExp(name.slice(lastIndex, match.index));
		paramNames.push(match[1] as string);
		pattern += "([^:]+)";
		lastIndex = PARAM_PATTERN.lastIndex;
		match = PARAM_PATTERN.exec(name);
	}
	pattern += escapeRegExp(name.slice(lastIndex));

	return { regex: new RegExp(`^${pattern}$`), paramNames };
}

export function matchRoute(
	compiled: CompiledRoute,
	value: string,
): Record<string, string> | undefined {
	const match = compiled.regex.exec(value);
	if (!match) return undefined;

	const params: Record<string, string> = {};
	for (let i = 0; i < compiled.paramNames.length; i++) {
		params[compiled.paramNames[i] as string] = decodeURIComponent(
			match[i + 1] as string,
		);
	}
	return params;
}

// Param values are percent-encoded before being substituted into a route's ":"-separated
// segments. This keeps a literal ":" (or any other char) inside a value from being confused
// with the route's own segment separator — without it, a value like "tenant:42" would either
// fail to match its own [^:]+ capture group, or (with multiple params) let a value's
// characters get misattributed to a neighboring param during regex backtracking.
export function buildRouteName(
	name: string,
	params: Record<string, string>,
): string {
	return name.replace(PARAM_PATTERN, (_, paramName: string) => {
		const value = params[paramName];
		if (value === undefined) {
			throw new Error(`Missing param "${paramName}" for route "${name}"`);
		}
		return encodeURIComponent(value);
	});
}
