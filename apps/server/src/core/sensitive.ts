import { HIDDEN } from '@hippocampe/api/model'
import { Effect } from 'effect'
import type { Schema } from 'effect'
import { Rights } from './auth/rights.ts'
import { listTypes } from './types/operations.ts'

/**
 * What the current caller may not see. A key without the right `sensitive` sees no value of a
 * field its type marks `sensitive`, and nothing of an entry whose type is sensitive: the server
 * hides them on every way out.
 */
export const sensitivity = Effect.gen(function* () {
  const allowed = (yield* Rights).includes('sensitive')
  const types = allowed ? [] : yield* listTypes
  const hiddenTypes = types.filter(({ sensitive }) => sensitive === true).map(({ name }) => name)
  const hiddenFields = new Map(
    types.map(({ name, fields }) => [
      name,
      fields.filter(({ sensitive }) => sensitive === true).map((field) => field.name),
    ]),
  )
  const fieldsOf = (type: string) => hiddenFields.get(type) ?? []
  return {
    allowed,
    /** The sensitive types, whose entries the caller may not see. */
    hiddenTypes,
    /** The sensitive fields of each type, by type name. */
    hiddenFields: Object.fromEntries(hiddenFields),
    hidesType: (type: string) => hiddenTypes.includes(type),
    fieldsOf,
    /** The fields of an entry, each sensitive value replaced by the marker. */
    maskFields: (type: string, fields: { readonly [name: string]: Schema.Json }) =>
      Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [
          name,
          fieldsOf(type).includes(name) ? HIDDEN : value,
        ]),
      ),
  }
})
