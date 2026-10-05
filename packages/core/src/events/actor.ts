import { Context, Effect } from 'effect'
import { Refused } from '../refused.ts'

/**
 * Who writes: an agent on a machine (`agent-laptop`) or a program (`importer`). The caller of a
 * write provides it; a write made without one is refused, so no event is ever anonymous.
 */
export const Actor = Context.Reference<string | undefined>('@grenier/core/events/Actor', {
  defaultValue: () => undefined,
})

/** The actor of the current write; refused when there is none. */
export const currentActor = Effect.gen(function* () {
  const actor = yield* Actor
  if (actor === undefined || actor.trim() === '') {
    return yield* new Refused({
      message: 'A write needs a current actor: name the agent or program that makes it.',
    })
  }
  return actor
})
