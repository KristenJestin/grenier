import { Context } from 'effect'
import type { Schema } from 'effect'

/**
 * The last call of each tool on one MCP server, by tool name, with its arguments as they were
 * given; kept only while diagnostics are on, so a report can name the call it is about.
 */
export const RecentCalls = Context.Reference<Map<string, Schema.Json | null>>(
  '@hippocampe/mcp/RecentCalls',
  { defaultValue: () => new Map() },
)
