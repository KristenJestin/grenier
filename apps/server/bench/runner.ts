import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTranscript, TOOL_PREFIX } from './transcript.ts'
import type { Transcript } from './transcript.ts'

/** What an agent is asked to do, and how it reaches Grenier. */
export interface AgentRequest {
  readonly prompt: string
  /** The address of the MCP endpoint of the Grenier under measurement. */
  readonly mcpUrl: string
  /** The secret of the key the agent writes with. */
  readonly key: string
  readonly model: string
  /** The most a single run may cost, in US dollars. */
  readonly maxCostUsd: number
  /** The longest a single run may last, in milliseconds. */
  readonly timeoutMs: number
}

/** What a run left: what the agent did, and the raw stream to read it again. */
export interface AgentRun {
  readonly transcript: Transcript
  readonly raw: string
  /** Why the run is not a measure of the tools, when it is not: a timeout, a leak. */
  readonly invalid: string | undefined
}

/** Anything that can play the agent of a task: Claude Code today, another client later. */
export interface AgentRunner {
  readonly name: string
  readonly run: (request: AgentRequest) => Promise<AgentRun>
}

/**
 * Claude Code, headless (`claude -p`), with the Grenier of the bench as its only tool source: the
 * MCP configuration is the one generated here (`--strict-mcp-config`), the built-in tools are
 * off, no settings file is read, and it starts from an empty folder, so no CLAUDE.md, project
 * setting, skill or MCP server of the machine reaches the session. What the session really had is
 * read back from its `init` event, and a run that had anything else is marked invalid.
 */
export const claudeCode = (executable = 'claude'): AgentRunner => ({
  name: 'claude-code',
  run: async (request) => {
    const folder = mkdtempSync(join(tmpdir(), 'grenier-bench-agent-'))
    try {
      const config = join(folder, 'mcp.json')
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            grenier: {
              type: 'http',
              url: request.mcpUrl,
              headers: { authorization: `Bearer ${request.key}` },
            },
          },
        }),
      )
      const work = join(folder, 'work')
      mkdirSync(work)
      const child = spawn(
        executable,
        [
          '-p',
          request.prompt,
          '--model',
          request.model,
          '--strict-mcp-config',
          '--mcp-config',
          config,
          '--tools',
          '',
          '--allowedTools',
          'mcp__grenier',
          '--permission-mode',
          'dontAsk',
          '--setting-sources',
          '',
          '--disable-slash-commands',
          '--no-session-persistence',
          '--max-budget-usd',
          String(request.maxCostUsd),
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let raw = ''
      child.stdout.on('data', (chunk: Buffer) => {
        raw += chunk.toString()
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), request.timeoutMs)
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      clearTimeout(timer)
      const transcript = parseTranscript(raw)
      const strangers = transcript.sessionTools.filter((tool) => !tool.startsWith(TOOL_PREFIX))
      const connected = transcript.mcpStatus.some(
        ({ name, status }) => name === 'grenier' && status === 'connected',
      )
      return {
        transcript,
        raw,
        invalid: !transcript.finished
          ? `the session did not finish (exit ${code})`
          : strangers.length > 0
            ? `the session had tools beyond the bench's: ${strangers.join(', ')}`
            : !connected
              ? 'the session did not connect to the Grenier of the bench'
              : undefined,
      }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  },
})
