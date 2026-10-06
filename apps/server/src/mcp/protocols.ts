import { McpProtocol } from 'effect/ai'

/** The MCP protocol versions the server speaks, newest first. */
export const PROTOCOLS = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const
