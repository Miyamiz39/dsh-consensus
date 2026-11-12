import { createHash } from 'node:crypto'
import catalog from './tool-catalog.json' with { type: 'json' }
import { ConsensusError } from './oauth.js'

export const BUNDLED_TOOLS = catalog.tools

export function publicToolName(rawName) {
  const joined = `mcp__consensus__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && joined.length <= 64) return joined
  const hash = createHash('sha256').update(`consensus\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

export function toolParameters(tool) {
  if (tool.name !== 'search') return tool.inputSchema
  // Existing conversations may group search filters under `filters`.
  return {
    ...tool.inputSchema,
    properties: {
      ...tool.inputSchema.properties,
      filters: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional grouped search filters. Keys are forwarded as top-level search parameters. Use the published search parameter names.',
      },
    },
  }
}

export function normalizeArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.query !== 'string' || !args.query.trim()) {
    throw new ConsensusError('Consensus search requires a non-empty query.')
  }
  if (args.page_size != null && (!Number.isInteger(args.page_size) || args.page_size < 1)) {
    throw new ConsensusError('Consensus page_size must be a positive integer.')
  }
  const { filters, ...rest } = args
  if (filters != null && (typeof filters !== 'object' || Array.isArray(filters))) {
    throw new ConsensusError('Consensus filters must be an object.')
  }
  if (filters && (Object.hasOwn(filters, 'query') || Object.hasOwn(filters, 'page_size'))) {
    throw new ConsensusError('Set query and page_size at the top level, not inside filters.')
  }
  return { ...filters, ...rest }
}
