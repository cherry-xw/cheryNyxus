import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
type Registration = Parameters<IngressContext['tools']['register']>[0]

/** A selection key is not a callable tool and cannot be supplied as authority by the model. */
export function withOperations<T extends Registration>(registration: T, field: string, values: readonly string[]): T {
  const name = registration.sense.definition.function.name
  const original = registration.sense.definition
  registration.sense.operationPolicy = {
    keys: values.map(value => `${name}.${value}`),
    key: args => `${name}.${args[field]}`,
    definition: allowed => {
      const definition = structuredClone(original)
      const permitted = values.filter(value => allowed.includes(`${name}.${value}`))
      const json = definition.function.parameters as Record<string, any>
      if (json.oneOf || json.anyOf) {
        for (const key of ['oneOf','anyOf']) if (json[key]) json[key] = json[key].filter((branch: any) =>
          permitted.includes(branch.properties?.[field]?.const) || branch.properties?.[field]?.enum?.some((value: string) => permitted.includes(value)))
      } else json.properties = { ...json.properties, [field]: { ...json.properties?.[field], enum: permitted } }
      return definition
    },
  }
  return registration
}

export const operationId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/)
