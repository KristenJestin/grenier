import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { Cause, Effect, Option, Schema, Struct } from 'effect'
import { SqlClient } from 'effect/sql'
import { drizzle } from '../database/client.ts'
import { rowsOf } from '../database/rows.ts'
import * as tables from '../database/schema.ts'
import { Actor } from '../events/actor.ts'
import { Instance } from '../instance.ts'
import { maskedCall } from './mask.ts'
import { SIMILAR, titleSimilarity } from './similar.ts'

export const FINDING_KINDS = [
  'bug',
  'tool_error',
  'unclear_refusal',
  'missing_capability',
  'wrong_state',
  'slow',
  'model_friction',
  'other',
] as const

/** From the worst to the least. */
export const SEVERITIES = ['blocks', 'hurts', 'cosmetic'] as const

const Text = (description: string) =>
  Schema.String.check(
    Schema.isNonEmpty({ expected: 'text that is not empty' }),
    Schema.isMaxLength(4000, { expected: 'text of 4000 characters at most' }),
  ).annotate({ description })

/** What an agent reports of a problem with Grenier itself. */
export const FindingReport = Schema.Struct({
  title: Schema.String.check(
    Schema.isNonEmpty({ expected: 'text that is not empty' }),
    Schema.isMaxLength(200, { expected: 'text of 200 characters at most' }),
  ).annotate({ description: 'The problem in one line, naming entries by slug only.' }),
  kind: Schema.Literals(FINDING_KINDS),
  place: Schema.String.check(
    Schema.isNonEmpty({ expected: 'text that is not empty' }),
    Schema.isMaxLength(200, { expected: 'text of 200 characters at most' }),
  ).annotate({ description: 'The tool or place concerned, such as `write` or `search`.' }),
  severity: Schema.Literals(SEVERITIES).annotate({
    description:
      '`blocks` (the work cannot go on), `hurts` (it goes on, worse) or `cosmetic` (a detail).',
  }),
  trying: Text('What you were trying to do.'),
  happened: Text('What happened.'),
  expected: Text('What you expected.'),
  steps: Schema.optionalKey(Text('How to make it happen again, step by step.')),
})
export type FindingReport = typeof FindingReport.Type

/** A tool call a finding is about: the tool, and its arguments as they were given. */
export type Call = { readonly tool: string; readonly arguments: Schema.Json | null }

const { findings, findingOccurrences } = tables

const iso = (column: typeof findings.first_seen | typeof findingOccurrences.at) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** A finding as it is listed: no occurrence, so nothing an agent or a key wrote in it. */
export const Finding = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  kind: Schema.Literals(FINDING_KINDS),
  place: Schema.String,
  severity: Schema.Literals(SEVERITIES),
  occurrences: Schema.Number,
  first_seen: Schema.String,
  last_seen: Schema.String,
})
export type Finding = typeof Finding.Type

const FINDING = {
  number: findings.number,
  title: findings.title,
  kind: findings.kind,
  place: findings.place,
  severity: findings.severity,
  occurrences: findings.occurrences,
  first_seen: iso(findings.first_seen),
  last_seen: iso(findings.last_seen),
}

/** One time a finding was seen. */
export const Occurrence = Schema.Struct({
  at: Schema.String,
  origin: Schema.Literals(['agent', 'server']),
  title: Schema.String,
  severity: Schema.Literals(SEVERITIES),
  trying: Schema.String,
  happened: Schema.String,
  expected: Schema.String,
  steps: Schema.String,
  instance: Schema.String,
  version: Schema.String,
  commit: Schema.String,
  key_name: Schema.NullOr(Schema.String),
  call_tool: Schema.NullOr(Schema.String),
  call_arguments: Schema.NullOr(Schema.String),
})

const OCCURRENCE = {
  at: iso(findingOccurrences.at),
  origin: findingOccurrences.origin,
  title: findingOccurrences.title,
  severity: findingOccurrences.severity,
  trying: findingOccurrences.trying,
  happened: findingOccurrences.happened,
  expected: findingOccurrences.expected,
  steps: findingOccurrences.steps,
  instance: findingOccurrences.instance,
  version: findingOccurrences.version,
  commit: findingOccurrences.commit,
  key_name: findingOccurrences.key_name,
  call_tool: findingOccurrences.call_tool,
  call_arguments: findingOccurrences.call_arguments,
}

const listed = rowsOf(Finding)
const seen = rowsOf(Schema.Struct({ finding: Schema.Number, ...Occurrence.fields }))

const worst = (
  left: (typeof SEVERITIES)[number],
  right: (typeof SEVERITIES)[number],
): (typeof SEVERITIES)[number] =>
  SEVERITIES.indexOf(left) <= SEVERITIES.indexOf(right) ? left : right

/**
 * Records a report: one more occurrence of the finding of the same kind and place whose title is
 * similar enough, or a new finding. The occurrence keeps what was reported, and what the server
 * adds: the instance, its version and commit, the current actor's key, and the call it is about,
 * its arguments masked and cut short. Reports are recorded one at a time, so two at once never
 * make the same finding twice.
 */
export const reportFinding = Effect.fn('reportFinding')(function* (
  report: FindingReport,
  call?: Call,
  origin: 'agent' | 'server' = 'agent',
) {
  const client = yield* SqlClient.SqlClient
  const db = yield* drizzle
  const instance = yield* Instance
  const key = yield* Actor
  const call_arguments =
    call === undefined || call.arguments === null ? null : yield* maskedCall(call.arguments)
  return yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client`SELECT pg_advisory_xact_lock(hashtext('grenier.findings'))`
      const candidates = yield* listed(
        db
          .select(FINDING)
          .from(findings)
          .where(and(eq(findings.kind, report.kind), eq(findings.place, report.place)))
          .orderBy(asc(findings.number)),
      )
      const [similar] = candidates
        .map((finding) => ({ finding, similarity: titleSimilarity(finding.title, report.title) }))
        .filter(({ similarity }) => similarity >= SIMILAR)
        .toSorted((left, right) => right.similarity - left.similarity)
      const [finding] =
        similar === undefined
          ? yield* listed(
              db
                .insert(findings)
                .values({
                  title: report.title,
                  kind: report.kind,
                  place: report.place,
                  severity: report.severity,
                })
                .returning(FINDING),
            )
          : yield* listed(
              db
                .update(findings)
                .set({
                  severity: worst(similar.finding.severity, report.severity),
                  occurrences: sql`${findings.occurrences} + 1`,
                  last_seen: sql`clock_timestamp()`,
                })
                .where(eq(findings.number, similar.finding.number))
                .returning(FINDING),
            )
      if (finding === undefined) return yield* Effect.die('a finding just written cannot be read')
      yield* db.insert(findingOccurrences).values({
        finding: finding.number,
        origin,
        title: report.title,
        severity: report.severity,
        trying: report.trying,
        happened: report.happened,
        expected: report.expected,
        steps: report.steps ?? '',
        instance: instance.name,
        version: instance.version,
        commit: instance.commit,
        key_name: key ?? null,
        call_tool: call?.tool ?? null,
        call_arguments,
      })
      return { finding, new: similar === undefined }
    }),
  )
})

/** The first line of a text, cut to `length` characters. */
const firstLine = (text: string, length: number) => {
  const [line = ''] = text.trim().split('\n')
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

/** The tag of a tagged error, such as `SqlError`. */
const Tagged = Schema.Struct({ _tag: Schema.String })

/**
 * Records an unexpected failure of the server (a defect, never a refusal) as an occurrence of a
 * `bug` at `place`, when diagnostics are on; does nothing otherwise. In production, where a
 * message, a stack or a statement could carry the owner's data, it keeps only the tag or class of
 * the error, the place and the tool; elsewhere, the message as the title and the stack with what
 * happened. Recording never fails the request it is about.
 */
export const recordDefect = Effect.fn('recordDefect')(function* <E>(
  place: string,
  cause: Cause.Cause<E>,
  call?: Call,
) {
  const instance = yield* Instance
  if (!instance.diagnostics || !Cause.hasDies(cause)) return
  const error = Cause.squash(cause)
  const production = instance.name === 'production'
  const message = error instanceof Error ? error.message : String(error)
  // The tag of a tagged error, else the name of its class: `SqlError`, `TypeError`.
  const name = Option.match(Schema.decodeUnknownOption(Tagged)(error), {
    onSome: ({ _tag }) => _tag,
    onNone: () => (error instanceof Error ? error.name : 'unknown'),
  })
  yield* reportFinding(
    {
      title: `Unexpected error: ${production ? name : firstLine(message, 180) || 'no message'}`,
      kind: 'bug',
      place,
      severity: 'blocks',
      trying: call === undefined ? `A request to ${place}.` : `A call of the tool ${call.tool}.`,
      happened: production
        ? 'The server failed unexpectedly; in production, its message and stack are not kept.'
        : Cause.pretty(cause).slice(0, 4000),
      expected: 'An answer or a refusal, not an unexpected error.',
    },
    call === undefined || !production ? call : { tool: call.tool, arguments: null },
    'server',
  ).pipe(
    Effect.catchCause((failed) =>
      Effect.logWarning('An unexpected error could not be recorded as a finding.', failed),
    ),
  )
})

export const FindingFilter = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(FINDING_KINDS)),
  place: Schema.optionalKey(Schema.String),
  severity: Schema.optionalKey(Schema.Literals(SEVERITIES)),
  number: Schema.optionalKey(Schema.Number),
})
export type FindingFilter = typeof FindingFilter.Type

const matching = (filter: FindingFilter) =>
  and(
    ...[
      filter.kind === undefined ? undefined : eq(findings.kind, filter.kind),
      filter.place === undefined ? undefined : eq(findings.place, filter.place),
      filter.severity === undefined ? undefined : eq(findings.severity, filter.severity),
      filter.number === undefined ? undefined : eq(findings.number, filter.number),
    ],
  )

/** The findings recorded so far, by number, a page at a time; never their occurrences. */
export const listFindings = Effect.fn('listFindings')(function* (
  page: { readonly limit: number; readonly offset: number },
  filter: FindingFilter = {},
) {
  const db = yield* drizzle
  const [counted] = yield* db.select({ total: count() }).from(findings).where(matching(filter))
  return {
    findings: yield* listed(
      db
        .select(FINDING)
        .from(findings)
        .where(matching(filter))
        .orderBy(asc(findings.number))
        .limit(page.limit)
        .offset(page.offset),
    ),
    total: counted?.total ?? 0,
  }
})

/** The findings that match `filter`, by number, each with all its occurrences, oldest first. */
export const findingsWithOccurrences = Effect.fn('findingsWithOccurrences')(function* (
  filter: FindingFilter,
) {
  const db = yield* drizzle
  const found = yield* listed(
    db.select(FINDING).from(findings).where(matching(filter)).orderBy(asc(findings.number)),
  )
  const occurrences =
    found.length === 0
      ? []
      : yield* seen(
          db
            .select({ finding: findingOccurrences.finding, ...OCCURRENCE })
            .from(findingOccurrences)
            .where(
              inArray(
                findingOccurrences.finding,
                found.map(({ number }) => number),
              ),
            )
            .orderBy(asc(findingOccurrences.at), asc(findingOccurrences.id)),
        )
  return found.map((finding) => ({
    finding,
    occurrences: occurrences
      .filter((occurrence) => occurrence.finding === finding.number)
      .map(Struct.omit(['finding'])),
  }))
})
