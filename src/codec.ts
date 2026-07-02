export interface Codec {
	encode(value: unknown): string;
	decode(raw: string): unknown;
}

export const jsonCodec: Codec = {
	encode(value) {
		return JSON.stringify(value);
	},
	decode(raw) {
		return JSON.parse(raw);
	},
};
