/** A query value as WordPress/PHP understands it. Arrays become `key[]=a&key[]=b`. */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryValue[]
  | { [key: string]: QueryValue };

export type Query = Record<string, QueryValue>;

function append(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        value.forEach((v, i) => {
          append(params, `${key}[${i}]`, v);
        });
        return;
      }
    }
    for (const item of value) append(params, `${key}[]`, item);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) append(params, `${key}[${k}]`, v);
    return;
  }
  params.append(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
}

/** Encode a query object with PHP bracket conventions, skipping undefined and null. */
export function toPhpQuery(query: Query | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (!query) return params;
  for (const [key, value] of Object.entries(query)) append(params, key, value);
  return params;
}
