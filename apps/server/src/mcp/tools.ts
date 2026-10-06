import { Rights } from '../core/auth/index.ts'
import { Refused } from '../core/refused.ts'
import { headsUp } from '../core/time/index.ts'
import { Effect, Schema } from 'effect'
import { Toolkit } from 'effect/ai'
import type { Database, defineTool } from './tool.ts'
import { addFieldTool } from './tools/add-field.ts'
import { archiveTool } from './tools/archive.ts'
import { attachMediaTool } from './tools/attach-media.ts'
import { briefingTool } from './tools/briefing.ts'
import { changeFieldTool } from './tools/change-field.ts'
import { changeTypeTool } from './tools/change-type.ts'
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
)

/** The tools at work on the database, the actor and the rights of the layer that builds them. */
export const GrenierHandlers = GrenierTools.toLayer(
  Effect.gen(function* () {
    const services = yield* Effect.context<Database>()
    const rights = yield* Rights

    /**
     * The handler of a tool: checks the caller's right, decodes the input with the tool's schema,
     * runs it, and answers a refusal with its sentences. Any other failure is a defect, reported
     * as an internal error.
     */
    const handlerOf =
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
          Effect.flatMap((answer) => Effect.map(headsUp, (heads_up) => ({ ...answer, heads_up }))),
          Effect.catch((error) =>
            error instanceof Refused ? Effect.fail(error) : Effect.die(error),
          ),
          Effect.provide(services),
        )

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
    }
  }),
)
