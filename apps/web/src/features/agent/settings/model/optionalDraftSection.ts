/** Reads absent sections without creating them. Only an explicit edit creates parents. */
export function optionalDraftSection<T extends object>(read: () => T | undefined, write: (value: T | undefined) => void): T {
  return new Proxy({} as T, {
    get: (_target, key) => Reflect.get(read() ?? {}, key),
    set: (_target, key, value) => {
      if (value === undefined) {
        if (!Object.hasOwn(read() ?? {}, key)) return true
        const next = { ...read() } as T
        Reflect.deleteProperty(next, key)
        write(Object.keys(next).length ? next : undefined)
      } else write({ ...read(), [key]: value } as T)
      return true
    },
    deleteProperty: (_target, key) => {
      if (!Object.hasOwn(read() ?? {}, key)) return true
      const next = { ...read() } as T
      Reflect.deleteProperty(next, key)
      write(Object.keys(next).length ? next : undefined)
      return true
    },
    ownKeys: () => Reflect.ownKeys(read() ?? {}),
    getOwnPropertyDescriptor: (_target, key) => Object.hasOwn(read() ?? {}, key) ? { enumerable: true, configurable: true } : undefined,
  })
}
