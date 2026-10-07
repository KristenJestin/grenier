import { Rights } from '../core/auth/index.ts'
import type { Right } from '../core/auth/index.ts'
import { recordDefect } from '../core/findings/index.ts'
import { Instance } from '../core/instance.ts'
import { Refused } from '../core/refused.ts'
import { headsUp } from '../core/time/index.ts'
import { Context, Effect, Layer, Schema } from 'effect'
import { McpSchema, McpServer, Toolkit } from 'effect/ai'
import { toToolInputSchema } from '@grenier/api/schema'
import { RecentCalls } from './calls.ts'
import { takenContent } from './tools/inbox-take.ts'
import { grenierReportTool } from './tools/grenier-report.ts'
import { grenierReportsTool } from './tools/grenier-reports.ts'
import type { Database, defineTool } from './tool.ts'
import { addFieldTool } from './tools/add-field.ts'
import { archiveTool } from './tools/archive.ts'
import { attachMediaTool } from './tools/attach-media.ts'
import { briefingTool } from './tools/briefing.ts'
import { changeFieldTool } from './tools/change-field.ts'
import { changeTypeTool } from './tools/change-type.ts'
import { unverifiedTool } from './tools/unverified.ts'
import { writeManyTool } from './tools/write-many.ts'
import {
  inboxAddTool,
  inboxDismissTool,
  inboxDoneTool,
  inboxListTool,
  inboxPeekTool,
  inboxReadTool,
  inboxReleaseTool,
  inboxTakeTool,
} from './tools/inbox.ts'
import { confirmProposalTool } from './tools/confirm-proposal.ts'
import { defineTypeTool } from './tools/define-type.ts'
import { describeMediaTool } from './tools/describe-media.ts'
import { getTypeTool } from './tools/get-type.ts'
import { historyTool } from './tools/history.ts'
import { linkTool } from './tools/link.ts'
import { listProposalsTool } from './tools/list-proposals.ts'
import { instanceRulesTool } from './tools/instance-rules.ts'
import { listTypesTool } from './tools/list-types.ts'
import { pendingReferencesTool } from './tools/pending-references.ts'
import { proposeTypeChangeTool } from './tools/propose-type-change.ts'
import { readTool } from './tools/read.ts'
import { searchTool } from './tools/search.ts'
import { unlinkTool } from './tools/unlink.ts'
import { upcomingTool } from './tools/upcoming.ts'
import { writeTool } from './tools/write.ts'

/** Every tool Grenier serves over MCP, each in its own module under `tools/`. */
export const GrenierTools = Toolkit.make(
  defineTypeTool.tool,
  addFieldTool.tool,
  getTypeTool.tool,
  listTypesTool.tool,
  pendingReferencesTool.tool,
  instanceRulesTool.tool,
  writeTool.tool,
  readTool.tool,
  archiveTool.tool,
  searchTool.tool,
  linkTool.tool,
  unlinkTool.tool,
  historyTool.tool,
  changeFieldTool.tool,
  changeTypeTool.tool,
  proposeTypeChangeTool.tool,
  listProposalsTool.tool,
  confirmProposalTool.tool,
  attachMediaTool.tool,
  describeMediaTool.tool,
  upcomingTool.tool,
  briefingTool.tool,
  unverifiedTool.tool,
  writeManyTool.tool,
  inboxAddTool.tool,
  inboxListTool.tool,
  inboxReadTool.tool,
  inboxReleaseTool.tool,
  inboxDoneTool.tool,
  inboxDismissTool.tool,
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
 * What a tool answers: its answer with the heads-up, or its refusal with the heads-up too. Any
 * other failure is a defect, reported as an internal error.
 */
export const answered = <A extends Schema.JsonObject, E, R>(answer: Effect.Effect<A, E, R>) =>
  answer.pipe(
    Effect.flatMap((data) => Effect.map(toldNow, (heads_up) => ({ ...data, heads_up }))),
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
      define_type: handlerOf(defineTypeTool),
      add_field: handlerOf(addFieldTool),
      get_type: handlerOf(getTypeTool),
      list_types: handlerOf(listTypesTool),
      pending_references: handlerOf(pendingReferencesTool),
      instance_rules: handlerOf(instanceRulesTool),
      write: handlerOf(writeTool),
      read: handlerOf(readTool),
      archive: handlerOf(archiveTool),
      search: handlerOf(searchTool),
      link: handlerOf(linkTool),
      unlink: handlerOf(unlinkTool),
      history: handlerOf(historyTool),
      change_field: handlerOf(changeFieldTool),
      change_type: handlerOf(changeTypeTool),
      propose_type_change: handlerOf(proposeTypeChangeTool),
      list_proposals: handlerOf(listProposalsTool),
      confirm_proposal: handlerOf(confirmProposalTool),
      attach_media: handlerOf(attachMediaTool),
      describe_media: handlerOf(describeMediaTool),
      upcoming: handlerOf(upcomingTool),
      briefing: handlerOf(briefingTool),
      unverified: handlerOf(unverifiedTool),
      write_many: handlerOf(writeManyTool),
      inbox_add: handlerOf(inboxAddTool),
      inbox_list: handlerOf(inboxListTool),
      inbox_read: handlerOf(inboxReadTool),
      inbox_release: handlerOf(inboxReleaseTool),
      inbox_done: handlerOf(inboxDoneTool),
      inbox_dismiss: handlerOf(inboxDismissTool),
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

/**
 * `inbox_take` and `inbox_peek`, beside the toolkit: their answer may hold an image the agent
 * sees, which a tool of the toolkit, answered as JSON, cannot give.
 */
const InboxTake = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer
    const services = yield* Effect.context<Database>()
    const handlerOf = handlerFor(services, yield* Rights)
    const add = <I, E>(tool: ReturnType<typeof defineTool<string, I, E>>) => {
      const handle = handlerOf(tool)
      const { name, description, input } = tool
      return server.addTool({
        tool: new McpSchema.Tool({ name, description, inputSchema: toToolInputSchema(input) }),
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
    }
    yield* add(inboxTakeTool)
    yield* add(inboxPeekTool)
  }),
)

/**
 * Every Grenier tool on an MCP server: the toolkit, `inbox_take` and `inbox_peek`; and the tools of diagnostics
 * when they are on (otherwise they do not exist, and a call to one is refused). The server keeps
 * the last call of each tool for itself alone.
 */
export const GrenierServer = Layer.unwrap(
  Effect.gen(function* () {
    const served = Layer.merge(
      McpServer.toolkit(GrenierTools).pipe(Layer.provide(GrenierHandlers)),
      InboxTake,
    )
    const withDiagnostics = (yield* Instance).diagnostics
      ? Layer.merge(
          served,
          McpServer.toolkit(DiagnosticsTools).pipe(Layer.provide(DiagnosticsHandlers)),
        )
      : served
    return withDiagnostics.pipe(Layer.provide(Layer.succeed(RecentCalls, new Map())))
  }),
)

/** The names of every tool, as an agent lists them, diagnostics off. */
export const TOOL_NAMES = [
  ...Object.keys(GrenierTools.tools),
  inboxTakeTool.name,
  inboxPeekTool.name,
]
