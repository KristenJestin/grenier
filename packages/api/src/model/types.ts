import { Schema } from 'effect'

/** An ISO 8601 duration: `P60D`, `P2W`, `P1Y6M`, `PT12H`. */
export const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/

const Notice = Schema.String.check(
  Schema.isPattern(ISO_DURATION, { expected: 'an ISO 8601 duration such as P60D' }),
).annotate({
  description:
    'How long before the date it is told as coming, an ISO 8601 duration such as `P60D` or `P2W`.',
})

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
  ).annotate({ description: 'The name of the field, in snake_case such as `monthly_cost`.' }),
  kind: Schema.Literals(FIELD_KINDS).annotate({
    description:
      'What the field holds. `enum` needs its `values`; `entry` points to other entries (see `types`); `date` may carry `due` or `recurs`.',
  }),
  required: Schema.optionalKey(Schema.Boolean).annotate({
    description: 'A write must give a value for the field (at least one when it is `many`).',
  }),
  values: Schema.optionalKey(
    Schema.Array(Text).check(
      Schema.isMinLength(1, { expected: 'a list of at least one value' }),
      Schema.isUnique({ expected: 'a list without repeated values' }),
    ),
  ).annotate({
    description: 'For an `enum` field only: the values it accepts, at least one, without repeats.',
  }),
  sensitive: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'The values of the field are shown and written only by a key with the right `sensitive`.',
  }),
  types: Schema.optionalKey(
    Schema.Array(Schema.String)
      .check(
        Schema.isMinLength(1, { expected: 'a list of at least one type' }),
        Schema.isUnique({ expected: 'a list without repeated types' }),
      )
      .annotate({
        description:
          'On an `entry` field only: the names of the types its entries may be of, such as `["organization"]`; a write naming an entry of another type is refused. Without it, any entry is accepted.',
      }),
  ),
  many: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'The field holds a list of values of its kind, in the order given and without duplicates, such as several sellers or languages; `required` then means at least one. Not with `due` or `recurs`.',
    }),
  ),
  due: Schema.optionalKey(Schema.Struct({ notice: Notice })).annotate({
    description:
      'For a `date` field only: the date is a deadline, told as coming `notice` before it.',
  }),
  recurs: Schema.optionalKey(
    Schema.Struct({
      every: Schema.Literals(['yearly', 'monthly', 'weekly']).annotate({
        description: 'How often the date comes back.',
      }),
      notice: Notice,
    }),
  ).annotate({
    description:
      'For a `date` field only: the date comes back, `every` year, month or week, told as coming `notice` before each time.',
  }),
})
  .annotate({
    description: 'A field of a type: its name, its kind and the rules a value of it follows.',
  })
  .check(
    Schema.makeFilter(({ kind, values, types, many, due, recurs }) => [
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
      ...(kind !== 'entry' && types !== undefined
        ? [{ path: ['types'], issue: 'is allowed only on an entry field' }]
        : []),
      ...(many === true && (due !== undefined || recurs !== undefined)
        ? [
            {
              path: ['many'],
              issue:
                'cannot be given with `due` or `recurs`: a deadline or a recurring date holds one date',
            },
          ]
        : []),
    ]),
  )
  .annotate({ identifier: 'FieldDefinition' })
export type FieldDefinition = typeof FieldDefinition.Type

/** A type of entry, defined at run time: the code knows no particular type. */
export const TypeDefinition = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, {
      expected: 'lowercase kebab-case text such as `bank-account`',
    }),
  ).annotate({
    description: 'The name of the type, in lowercase kebab-case such as `bank-account`.',
  }),
  label: Text.annotate({ description: 'The name of the type as people read it.' }),
  description: Text.annotate({
    description:
      'What the type is and when to use it, in the words a user would say: agents choose a type from it.',
  }),
  sensitive: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Every entry of the type is sensitive: shown only to a key with the right `sensitive`.',
  }),
  read_in_parent: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      'Entries of the type that are part of an entry of the same type are read in that entry, with their fields, as the parts of a whole (the disks of a computer), rather than as entries of their own in the tree.',
  }),
  fields: Schema.Array(FieldDefinition)
    .annotate({
      description: 'The fields of the type; none is a type with a title and a body only.',
    })
    .check(
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
}).annotate({ identifier: 'TypeDefinition' })
export type TypeDefinition = typeof TypeDefinition.Type
