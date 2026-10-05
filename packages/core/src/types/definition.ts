import { Schema } from 'effect'

/** An ISO 8601 duration: `P60D`, `P2W`, `P1Y6M`, `PT12H`. */
export const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/

const Notice = Schema.String.check(
  Schema.isPattern(ISO_DURATION, { expected: 'an ISO 8601 duration such as P60D' }),
)

const Text = Schema.String.check(Schema.isNonEmpty({ expected: 'text that is not empty' }))

export const FIELD_KINDS = [
  'text',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'duration',
  'enum',
  'money',
  'url',
  'entry',
] as const

/** One field of a type: its name, its kind, and the rules a value of it follows. */
export const FieldDefinition = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, {
      expected: 'snake_case text such as `monthly_cost`',
    }),
  ),
  kind: Schema.Literals(FIELD_KINDS),
  required: Schema.optionalKey(Schema.Boolean),
  values: Schema.optionalKey(
    Schema.Array(Text).check(
      Schema.isMinLength(1, { expected: 'a list of at least one value' }),
      Schema.isUnique({ expected: 'a list without repeated values' }),
    ),
  ),
  sensitive: Schema.optionalKey(Schema.Boolean),
  due: Schema.optionalKey(Schema.Struct({ notice: Notice })),
  recurs: Schema.optionalKey(
    Schema.Struct({ every: Schema.Literals(['yearly', 'monthly', 'weekly']), notice: Notice }),
  ),
}).check(
  Schema.makeFilter(({ kind, values, due, recurs }) => [
    ...(kind === 'enum' && values === undefined
      ? [{ path: ['values'], issue: 'must list the allowed values of an enum field' }]
      : []),
    ...(kind !== 'enum' && values !== undefined
      ? [{ path: ['values'], issue: 'is allowed only on an enum field' }]
      : []),
    ...(kind !== 'date' && due !== undefined
      ? [{ path: ['due'], issue: 'is allowed only on a date field' }]
      : []),
    ...(kind !== 'date' && recurs !== undefined
      ? [{ path: ['recurs'], issue: 'is allowed only on a date field' }]
      : []),
  ]),
)
export type FieldDefinition = typeof FieldDefinition.Type

/** A type of entry, defined at run time: the code knows no particular type. */
export const TypeDefinition = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, {
      expected: 'lowercase kebab-case text such as `bank-account`',
    }),
  ),
  label: Text,
  description: Text,
  fields: Schema.Array(FieldDefinition).check(
    Schema.makeFilter((fields) =>
      fields.flatMap(({ name }, index) =>
        fields.findIndex((other) => other.name === name) < index
          ? [
              {
                path: [index, 'name'],
                issue: `must differ from the names of the other fields: \`${name}\` is already used`,
              },
            ]
          : [],
      ),
    ),
  ),
})
export type TypeDefinition = typeof TypeDefinition.Type
