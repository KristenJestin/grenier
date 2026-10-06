import { McpProtocol } from 'effect/ai'

/**
 * The MCP protocol versions the server speaks, newest first: 2026-07-28 is stateless (no
 * handshake, no session); the older ones stay for the clients that have not moved yet.
 */
export const PROTOCOLS = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const
