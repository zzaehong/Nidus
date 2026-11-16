// Minimal JSON Schema check for tool inputs. Covers the keywords tool
// definitions use in practice; unknown keywords are ignored, not rejected.
import type { JsonSchema } from './contract.js';

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

/** Returns null when the value satisfies the schema, otherwise a short reason. */
export function schemaError(value: unknown, schema: JsonSchema, path = 'input', depth = 0): string | null {
  if (depth > 32) return `${path}: schema is nested too deeply`;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeof type === 'string' && matchesType(value, type))) return `${path}: expected ${types.join(' or ')}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) {
    return `${path}: value is not one of the allowed options`;
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path}: too short`;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${path}: too long`;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path}: below minimum`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path}: above maximum`;
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    for (const [index, item] of value.entries()) {
      const error = schemaError(item, schema.items as JsonSchema, `${path}[${index}]`, depth + 1);
      if (error) return error;
    }
  }

  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, JsonSchema> : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in record)) return `${path}: missing required property "${key}"`;
      }
    }
    for (const [key, item] of Object.entries(record)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        const error = schemaError(item, propertySchema, `${path}.${key}`, depth + 1);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return `${path}: unexpected property "${key}"`;
      }
    }
  }
  return null;
}
