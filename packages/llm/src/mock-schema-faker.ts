import { ZodArray, ZodDefault, ZodEnum, ZodLiteral, ZodNullable, ZodNumber, ZodObject, ZodOptional, ZodRecord, ZodString, ZodType, ZodUnion } from "zod";

/**
 * Generates a schema-valid fake value by introspecting a Zod schema. Used
 * only by MockLLMProvider so the system is runnable end to end (including
 * structured generation) without a real API key — the fake values carry no
 * semantic meaning, just satisfy the shape/constraints.
 */
export function fakeFromSchema<T>(schema: ZodType<T>): T {
  return buildValue(schema) as T;
}

function buildValue(schema: ZodType): unknown {
  if (schema instanceof ZodOptional || schema instanceof ZodNullable) {
    return buildValue(schema.unwrap());
  }
  if (schema instanceof ZodDefault) {
    return buildValue(schema.removeDefault());
  }
  if (schema instanceof ZodObject) {
    const shape = schema.shape as Record<string, ZodType>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      out[key] = buildValue(shape[key]);
    }
    return out;
  }
  if (schema instanceof ZodArray) {
    return [buildValue(schema.element), buildValue(schema.element)];
  }
  if (schema instanceof ZodRecord) {
    return { mock_key: buildValue(schema.valueSchema) };
  }
  if (schema instanceof ZodEnum) {
    return schema.options[0];
  }
  if (schema instanceof ZodLiteral) {
    return schema.value;
  }
  if (schema instanceof ZodUnion) {
    return buildValue(schema.options[0]);
  }
  if (schema instanceof ZodNumber) {
    const checks = schema._def.checks ?? [];
    const min = checks.find((c) => c.kind === "min") as { value: number } | undefined;
    const max = checks.find((c) => c.kind === "max") as { value: number } | undefined;
    if (min && max) return (min.value + max.value) / 2;
    if (min) return min.value;
    if (max) return max.value;
    return 1;
  }
  if (schema instanceof ZodString) {
    return "mock value";
  }
  // Booleans and anything else not explicitly handled.
  return true;
}
