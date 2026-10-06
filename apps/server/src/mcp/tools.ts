import { Rights } from '../core/auth/index.ts'
import type { Right } from '../core/auth/index.ts'
import { Refused } from '../core/refused.ts'
import { headsUp } from '../core/time/index.ts'
import { Context, Effect, Layer, Schema } from 'effect'
import { McpSchema, McpServer, Toolkit } from 'effect/ai'
import { toToolInputSchema } from '@grenier/api/schema'
import { takenContent } from './tools/inbox-take.ts'
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
  inboxTakeTool,
} from './tools/inbox.ts'
import { confirmProposalTool } from './tools/confirm-proposal.ts'
import { defineTypeTool } from './tools/define-type.ts'
import { describeMediaTool } from './tools/describe-media.ts'
import { getTypeTool } from './tools/get-type.ts'
import { historyTool } from './tools/history.ts'
import { linkTool } from './tools/link.ts'
import { listProposalsTool } from './tools/list-proposals.ts'
import { listTypesTool } from './tools/list-types.ts'
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
  inboxDoneTool.tool,
  inboxDismissTool.tool,
)

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
 * The handler of a tool, for a caller with `rights`, on `services`: checks the caller's right,
 * decodes the input with the tool's schema, runs it, and answers a refusal with its sentences.
 * Any other failure is a defect, reported as an internal error.
 */
const handlerFor =
  (services: Context.Context<Database>, rights: ReadonlyArray<Right>) =>
  <I, E>({ right, input, run }: ReturnType<typeof defineTool<string, I, E>>) =>
  <P>(parameters: P) =>
    (rights.includes(right)
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
      Effect.provide(services),
    )

/** The tools at work on the database, the actor and the rights of the layer that builds them. */
export const GrenierHandlers = GrenierTools.toLayer(
  Effect.gen(function* () {
    const handlerOf = handlerFor(yield* Effect.context<Database>(), yield* Rights)

    return {
      define_type: handlerOf(defineTypeTool),
      add_field: handlerOf(addFieldTool),
      get_type: handlerOf(getTypeTool),
      list_types: handlerOf(listTypesTool),
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
      inbox_done: handlerOf(inboxDoneTool),
      inbox_dismiss: handlerOf(inboxDismissTool),
    }
  }),
)

/**
 * `inbox_take`, beside the toolkit: its answer may hold an image the agent sees, which a tool of
 * the toolkit, answered as JSON, cannot give.
 */
const InboxTake = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer
    const services = yield* Effect.context<Database>()
    const handle = handlerFor(services, yield* Rights)(inboxTakeTool)
    const { name, description, input } = inboxTakeTool
    yield* server.addTool({
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
  }),
)

/** Every Grenier tool on an MCP server: the toolkit, and `inbox_take`. */
export const GrenierServer = Layer.merge(
  McpServer.toolkit(GrenierTools).pipe(Layer.provide(GrenierHandlers)),
  InboxTake,
)

/** The names of every tool, as an agent lists them. */
export const TOOL_NAMES = [...Object.keys(GrenierTools.tools), inboxTakeTool.name]
