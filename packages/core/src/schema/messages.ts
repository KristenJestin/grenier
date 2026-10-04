import { Match, Predicate, Schema, SchemaIssue } from 'effect'
import type { SchemaAST } from 'effect'
import type { StandardSchemaV1 } from 'effect/StandardSchema'

/**
 * Schema's own messages are written for developers ("Expected number, got \"x\""). What a person
 * reads says which field is wrong and how, in one short sentence; no raw Schema message reaches a
 * screen.
 */
const problemOf: SchemaIssue.LeafHook = (issue) =>
  Match.value(issue).pipe(
    Match.tag('MissingKey', () => 'is missing'),
    Match.tag('InvalidType', ({ ast }) => mustBe(ast)),
    Match.tag('UnexpectedKey', () => 'is not expected'),
    Match.orElse(() => 'is not valid'),
  )

/** A failed refinement says what it expects: Schema's checks carry it in plain English. */
const problemOfCheck: SchemaIssue.CheckHook = ({ filter }) => {
  const expected = filter.annotations?.expected
  return Predicate.isString(expected) ? `must be ${expected}` : 'is not valid'
}

const mustBe = (ast: SchemaAST.AST): string =>
  Match.value(ast).pipe(
    Match.tag('String', () => 'must be text'),
    Match.tag('Number', () => 'must be a number'),
    Match.tag('Boolean', () => 'must be true or false'),
    Match.tag('Arrays', () => 'must be a list'),
    Match.tag('Objects', () => 'must be a set of fields'),
    Match.orElse(() => 'is not valid'),
  )

const problems = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: problemOf,
  checkHook: problemOfCheck,
})

/** One sentence per problem: "The field `port` must be a number." */
export function formatSchemaError(error: Schema.SchemaError): string {
  return problems(error.issue)
    .issues.map(({ path, message }) =>
      path === undefined || path.length === 0
        ? `The value ${message}.`
        : `The field \`${path.map(String).join('.')}\` ${message}.`,
    )
    .join(' ')
}

/**
 * The Standard Schema a form validates with. Each field in error receives one sentence written
 * for the person filling the form: "This field must be a number."
 */
export function toFormSchema<S extends Schema.Decoder<unknown>>(
  schema: S,
): StandardSchemaV1<S['Encoded'], S['Type']> & S {
  return Schema.toStandardSchemaV1(schema, {
    leafHook: (issue) => `This field ${problemOf(issue)}.`,
    checkHook: (issue) => `This field ${problemOfCheck(issue)}.`,
  })
}
