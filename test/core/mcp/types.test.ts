import { describe, it, expect } from 'vitest'
import { MCP_PREFIX, RESOURCE_SENSE_SUFFIX, PROMPT_SENSE_SUFFIX, McpServerError } from '@/core/mcp/types.js'

describe('MCP types constants', () => {
  it('MCP_PREFIX is mcp__', () => {
    expect(MCP_PREFIX).toBe('mcp__')
  })

  it('RESOURCE_SENSE_SUFFIX is read_resource', () => {
    expect(RESOURCE_SENSE_SUFFIX).toBe('read_resource')
  })

  it('PROMPT_SENSE_SUFFIX is get_prompt', () => {
    expect(PROMPT_SENSE_SUFFIX).toBe('get_prompt')
  })
})

describe('McpServerError', () => {
  it('sets name, message, and code', () => {
    const err = new McpServerError('test error', 'NOT_FOUND')
    expect(err.name).toBe('McpServerError')
    expect(err.message).toBe('test error')
    expect(err.code).toBe('NOT_FOUND')
  })

  it('supports INVALID_PARAMS code', () => {
    const err = new McpServerError('bad params', 'INVALID_PARAMS')
    expect(err.code).toBe('INVALID_PARAMS')
  })

  it('is an instance of Error', () => {
    const err = new McpServerError('x', 'NOT_FOUND')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(McpServerError)
  })
})
