import type { Sense } from '../senseCreator.js'
import type { SenseFunction } from '../adapter.js'
import type { ZodType } from 'zod'

/**
 * 构建基础感官函数定义
 * 提供共享的感官构建逻辑，Provider 可在此基础上添加特定字段
 */
export function buildBaseSenseFunction(sense: Sense<ZodType>): SenseFunction['function'] {
  return {
    name: sense.definition.function.name,
    description: sense.definition.function.description,
    parameters: sense.definition.function.parameters,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict tools require closed objects with all properties required, including nested schemas. */
export function supportsStrictToolSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return true
  const objectSchema = schema.type === 'object' || isRecord(schema.properties)
  if (objectSchema) {
    if (schema.additionalProperties !== false) return false
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [])
    if (Object.keys(properties).some(name => !required.has(name))) return false
    if (!Object.values(properties).every(supportsStrictToolSchema)) return false
  }
  if (schema.items !== undefined && !supportsStrictToolSchema(schema.items)) return false
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[key]
    if (Array.isArray(variants) && !variants.every(supportsStrictToolSchema)) return false
  }
  return true
}
