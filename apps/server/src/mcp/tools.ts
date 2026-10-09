import { Rights } from '../core/auth/index.ts'
import type { Right } from '../core/auth/index.ts'
import { recordDefect } from '../core/findings/index.ts'
import { Instance } from '../core/instance.ts'
import { Refused } from '../core/refused.ts'
import { headsUp } from '../core/time/index.ts'
import { Context, Effect, Layer, Schema } from 'effect'
import { McpSchema, McpServer, Toolkit } from 'effect/ai'
import type { Tool } from 'effect/ai'
import { toToolInputSchema } from '@grenier/api/schema'
import { RecentCalls } from './calls.ts'
import { takenContent } from './tools/inbox-take.ts'
import { grenierReportTool } from './tools/grenier-report.ts'
import { grenierReportsTool } from './tools/grenier-reports.ts'
import type { Database, defineTool } from './tool.ts'
import { attachMediaTool } from './tools/attach-media.ts'
import { briefingTool } from './tools/briefing.ts'
import { changeTypeTool } from './tools/change-type.ts'
import { defineTypeTool } from './tools/define-type.ts'
import { inboxAddTool, inboxFinishTool, inboxListTool, inboxTakeTool } from './tools/inbox.ts'
import { linkTool } from './tools/link.ts'
import { readTool } from './tools/read.ts'
import { searchTool } from './tools/search.ts'
import { typesTool } from './tools/types.ts'
import { writeTool } from './tools/write.ts'

/** Every tool Grenier serves over MCP, each in its own module under `tools/`. */
export const GrenierTools = Toolkit.make(
  searchTool.tool,
  readTool.tool,
  briefingTool.tool,
  typesTool.tool,
  writeTool.tool,
  linkTool.tool,
  attachMediaTool.tool,
  defineTypeTool.tool,
  changeTypeTool.tool,
  inboxAddTool.tool,
  inboxFinishTool.tool,
)

/** The tools of diagnostics, served only when they are on. */
export const DiagnosticsTools = Toolkit.make(grenierReportTool.tool, grenierReportsTool.tool)

/**
 * The dates entering their notice period for the current actor. One that cannot be told is
 * none: the answer it goes with stands, so that an agent never retries a write that succeeded.
 */
const toldNow = headsUp.pipe(
  Effect.catchCause((cause) =>
    Effect.as(Effect.logWarning('The heads-up could not be told.', cause), []),
  ),
)

/** A refusal that also tells the dates entering their notice period, when there are some. */
const refusalWith = (refused: Refused, heads_up: Effect.Success<typeof toldNow>) =>
  heads_up.length === 0
    ? refused
    : new Refused({ message: `${refused.message}\n\nheads_up: ${JSON.stringify(heads_up)}` })

/**
 * What a tool answers: its answer with the heads-up, or its refusal with the heads-up too; with
 * nothing to tell, neither carries one. Any other failure is a defect, reported as an internal error.
 */
export const answered = <A extends Schema.JsonObject, E, R>(answer: Effect.Effect<A, E, R>) =>
  answer.pipe(
    Effect.flatMap((data) =>
      Effect.map(toldNow, (heads_up) => (heads_up.length === 0 ? data : { ...data, heads_up })),
    ),
    Effect.catchIf(
      Schema.is(Refused),
      (refused) =>
        Effect.flatMap(toldNow, (heads_up) => Effect.fail(refusalWith(refused, heads_up))),
      Effect.die,
    ),
  )

/**
 * The arguments of a call as JSON, kept as the last call of its tool while diagnostics are on;
 * `null` when they are off.
 */
const remembered = (name: string, parameters: Schema.Json) =>
  Effect.gen(function* () {
    if (!(yield* Instance).diagnostics) return null
    ;(yield* RecentCalls).set(name, parameters)
    return parameters
  })

/**
 * The handler of a tool, for a caller with `rights`, on `services`: checks the caller's right,
 * decodes the input with the tool's schema, runs it, and answers a refusal with its sentences.
 * Any other failure is a defect, reported as an internal error, and recorded as a finding when
 * diagnostics are on.
 */
const handlerFor =
  (services: Context.Context<Database>, rights: ReadonlyArray<Right>) =>
  <I, E>({ name, right, input, run }: ReturnType<typeof defineTool<string, I, E>>) =>
  <P>(parameters: P) =>
    Effect.gen(function* () {
      const given = yield* Schema.decodeUnknownEffect(Schema.Json)(parameters).pipe(
        Effect.orElseSucceed(() => null),
      )
      const call = { tool: name, arguments: given === null ? null : yield* remembered(name, given) }
      return yield* (
        rights.includes(right)
          ? Effect.void
          : Effect.fail(
              new Refused({
                message: `This key may not ${right}: ask the owner of Grenier for a key with the right \`${right}\`.`,
              }),
            )
      ).pipe(
        Effect.andThen(
          Schema.decodeUnknownEffect(input)(parameters, {
            errors: 'all',
            onExcessProperty: 'error',
          }).pipe(Effect.mapError(Refused.fromSchemaError)),
        ),
        Effect.flatMap(run),
        // Every answer carries the dates entering their notice period, once a day per actor.
        answered,
        Effect.tapCause((cause) => recordDefect(name, cause, call)),
      )
    }).pipe(Effect.provide(services))

/** The tools at work on the database, the actor and the rights of the layer that builds them. */
export const GrenierHandlers = GrenierTools.toLayer(
  Effect.gen(function* () {
    const handlerOf = handlerFor(yield* Effect.context<Database>(), yield* Rights)

    return {
      search: handlerOf(searchTool),
      read: handlerOf(readTool),
      briefing: handlerOf(briefingTool),
      types: handlerOf(typesTool),
      write: handlerOf(writeTool),
      link: handlerOf(linkTool),
      attach_media: handlerOf(attachMediaTool),
      define_type: handlerOf(defineTypeTool),
      change_type: handlerOf(changeTypeTool),
      inbox_add: handlerOf(inboxAddTool),
      inbox_finish: handlerOf(inboxFinishTool),
    }
  }),
)

/** The tools of diagnostics at work, as the other tools. */
const DiagnosticsHandlers = DiagnosticsTools.toLayer(
  Effect.gen(function* () {
    const handlerOf = handlerFor(yield* Effect.context<Database>(), yield* Rights)
    return {
      grenier_report: handlerOf(grenierReportTool),
      grenier_reports: handlerOf(grenierReportsTool),
    }
  }),
)

const toolOf = <T extends { readonly tool: Tool.Any }>({ tool }: T) => tool

/** Whether a key with `rights` lists a tool: it holds the right the tool needs. */
const listedTo = (rights: ReadonlyArray<Right>) => (tool: { readonly right: Right }) =>
  rights.includes(tool.right)

/**
 * `inbox_list` and `inbox_take`, beside the toolkit: their answer may hold an image the agent
 * sees (one item read or taken), which a tool of the toolkit, answered as JSON, cannot give.
 */
const registerByHand = <I, E>(tool: ReturnType<typeof defineTool<string, I, E>>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer
    const services = yield* Effect.context<Database>()
    const handle = handlerFor(services, yield* Rights)(tool)
    const { name, description, input, annotations } = tool
    return yield* server.addTool({
      tool: new McpSchema.Tool({
        name,
        description,
        inputSchema: toToolInputSchema(input),
        annotations,
      }),
      annotations: Context.empty(),
      handle: (parameters) =>
        handle(parameters).pipe(
          Effect.flatMap((answer) => Effect.provide(takenContent(answer), services)),
          Effect.catchIf(Schema.is(Refused), ({ message }) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                content: [{ type: 'text', text: message }],
              }),
            ),
          ),
          Effect.orDie,
        ),
    })
  })

/** The tools of the toolkit that come before `inbox_list`, in the order an agent lists them. */
const BEFORE_INBOX = [
  searchTool,
  readTool,
  briefingTool,
  typesTool,
  writeTool,
  linkTool,
  attachMediaTool,
  defineTypeTool,
  changeTypeTool,
  inboxAddTool,
]

/** The tools of the toolkit that come after `inbox_take`. */
const AFTER_INBOX = [inboxFinishTool]

/** The tools of the toolkit among `tools` that the key lists, registered together. */
const registerListed = (tools: ReadonlyArray<{ readonly tool: Tool.Any; readonly right: Right }>) =>
  Effect.gen(function* () {
    const listed = listedTo(yield* Rights)
    const kept = tools.filter(listed)
    if (kept.length > 0) yield* McpServer.registerToolkit(Toolkit.make(...kept.map(toolOf)))
  })

/**
 * Every Grenier tool on an MCP server, only those the key may call, and in the order of `TOOLS`
 * (then the tools of diagnostics, when they are on; otherwise they do not exist). A tool the key
 * lacks the right for is not listed, and a call to it is refused as an unknown tool. The server
 * keeps the last call of each tool for itself alone.
 */
export const GrenierServer = Layer.effectDiscard(
  Effect.gen(function* () {
    const listed = listedTo(yield* Rights)
    const diagnostics = (yield* Instance).diagnostics
    yield* registerListed(BEFORE_INBOX)
    if (listed(inboxListTool)) yield* registerByHand(inboxListTool)
    if (listed(inboxTakeTool)) yield* registerByHand(inboxTakeTool)
    yield* registerListed(AFTER_INBOX)
    if (diagnostics) yield* registerListed(DIAGNOSTICS_TOOLS)
  }),
).pipe(
  Layer.provide(Layer.merge(GrenierHandlers, DiagnosticsHandlers)),
  Layer.provide(Layer.succeed(RecentCalls, new Map())),
)

/** Every tool of Grenier, in the fixed order an agent lists them. */
export const TOOLS = [...BEFORE_INBOX, inboxListTool, inboxTakeTool, ...AFTER_INBOX]

/** The tools of diagnostics, listed after the others when they are on. */
export const DIAGNOSTICS_TOOLS = [grenierReportTool, grenierReportsTool]

/** The names of every tool, as an agent lists them, diagnostics off. */
export const TOOL_NAMES = TOOLS.map(({ name }) => name)
