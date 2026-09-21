/**
 * JSON Schemas for the structured replies the app asks models for, and their translation for providers that can enforce
 * a schema natively (so the reply cannot be malformed, only cut short).
 *
 * The schemas are deliberately flat and small: a reply that is short and simple to write is a reply that arrives complete.
 */

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: (string | number | boolean | null)[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  nullable?: boolean;
  [key: string]: unknown;
}

export const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
export const strList = (description?: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) });
export const list = (items: JsonSchema, description?: string): JsonSchema => ({ type: 'array', items, ...(description ? { description } : {}) });

/** An object in which every property is present, except any named in `optional`: what a prompt that lists its fields expects. */
export function obj(props: Record<string, JsonSchema>, optional: string[] = []): JsonSchema {
  return { type: 'object', properties: props, required: Object.keys(props).filter((k) => !optional.includes(k)), additionalProperties: false };
}

/**
 * The subset of JSON Schema that Gemini accepts as `responseSchema`: OpenAPI-style, upper-case type names, no
 * `additionalProperties`, no limits or formats. Anything else is dropped rather than risk a 400 for an unknown field
 * (the adapter also retries without a schema if a model refuses one).
 */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let type = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    if (type.includes('null')) nullable = true;
    type = type.find((t) => t !== 'null');
  }
  if (!type && schema.anyOf) {
    const nonNull = schema.anyOf.filter((s) => s.type !== 'null');
    if (nonNull.length !== schema.anyOf.length) nullable = true;
    if (nonNull.length === 1 && nonNull[0]) return { ...toGeminiSchema(nonNull[0]), ...(nullable ? { nullable: true } : {}) };
  }
  if (typeof type === 'string') out.type = type.toUpperCase();
  if (nullable) out.nullable = true;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum.map(String);
  if (schema.properties) {
    const keys = Object.keys(schema.properties);
    out.properties = Object.fromEntries(keys.map((k) => [k, toGeminiSchema(schema.properties?.[k] as JsonSchema)]));
    out.propertyOrdering = keys;
    if (schema.required) out.required = schema.required.filter((k) => keys.includes(k));
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

/** The wrapper OpenAI-style servers expect for a schema-constrained reply. `strict` is only meaningful to OpenAI itself. */
export function toResponseFormat(schema: JsonSchema, name: string, strict: boolean): Record<string, unknown> {
  return { type: 'json_schema', json_schema: { name, schema, ...(strict ? { strict: true } : {}) } };
}
