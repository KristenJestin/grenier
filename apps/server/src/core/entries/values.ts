import { Schema } from 'effect'
import { ISO_DURATION, PROVENANCES } from '@grenier/api/model'
import type { FieldDefinition, TypeDefinition } from '@grenier/api/model'

/** Text with what it must be, said both when it is not text and when its content is wrong. */
const textThat = (expected: string, isValid: (value: string) => boolean) =>
  Schema.String.annotate({ expected }).check(Schema.makeFilter(isValid, { expected }))

export const isDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)

export const isDateTime = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value))

const isWebUrl = (value: string) => /^https?:\/\//.test(value) && URL.canParse(value)

export const DateText = textThat('a date such as `2026-10-05`', isDate)

export const Text = Schema.String.check(Schema.isNonEmpty({ expected: 'text that is not empty' }))

export const Slug = textThat('lowercase kebab-case text such as `internet-at-home`', (value) =>
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value),
)

export const Provenance = textThat('one of `extracted`, `inferred`, `ambiguous`', (value) =>
  PROVENANCES.some((provenance) => provenance === value),
)

type Value = Schema.Codec<Schema.Json, Schema.Json>

/** The schema a value of a field of that kind is decoded with. */
const VALUES = {
  text: () => Schema.String,
  integer: () =>
    Schema.Number.annotate({ expected: 'an integer' }).check(
      Schema.isInt({ expected: 'an integer' }),
    ),
  number: () => Schema.Finite.annotate({ expected: 'a number' }),
  boolean: () => Schema.Boolean,
  date: () => DateText,
  datetime: () => textThat('a date and time such as `2026-10-05T14:30:00Z`', isDateTime),
  duration: () =>
    textThat('an ISO 8601 duration such as `P60D`', (value) => ISO_DURATION.test(value)),
  enum: ({ values = [] }) =>
    textThat(`one of ${values.map((value) => `\`${value}\``).join(', ')}`, (value) =>
      values.includes(value),
    ),
  money: () =>
    textThat('an amount and its currency such as `12.50 EUR`', (value) =>
      /^-?\d+(\.\d+)? [A-Z]{3}$/.test(value),
    ),
  url: () => textThat('a URL such as `https://example.org`', isWebUrl),
  entry: () => Schema.String.annotate({ expected: 'the slug or id of an entry' }),
} satisfies { readonly [K in FieldDefinition['kind']]: (field: FieldDefinition) => Value }

/**
 * The schema of a value of a field: one value of its kind, or for a field that is `many`, a list
 * of them without duplicates, at least one when the field is required.
 */
const valueOf = (field: FieldDefinition): Value => {
  const one = VALUES[field.kind](field)
  if (field.many !== true) return one
  const list = Schema.Array(one).check(
    Schema.isUnique({ expected: 'a list without repeated values' }),
  )
  return field.required === true
    ? list.check(Schema.isMinLength(1, { expected: 'a list of at least one value' }))
    : list
}

/** The values of the fields of an entry, by field name. */
export type FieldValues = { readonly [name: string]: Schema.Json }

/** The schema of the `fields` of an entry of that type, built from the type at run time. */
export function fieldsOf(type: TypeDefinition): Schema.Codec<FieldValues, FieldValues> {
  // An empty Struct accepts any value: a type without fields refuses every key itself.
  if (type.fields.length === 0) {
    return Schema.Record(Schema.String, Schema.Json).check(
      Schema.makeFilter((values) =>
        Object.keys(values).map((name) => ({ path: [name], issue: 'is not expected' })),
      ),
    )
  }
  return Schema.Struct(
    Object.fromEntries(
      type.fields.map((field): [string, Value | Schema.optionalKey<Value>] => {
        const value = valueOf(field)
        return [field.name, field.required === true ? value : Schema.optionalKey(value)]
      }),
    ),
  )
}
