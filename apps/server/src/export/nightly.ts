import { Config, Cron, Effect, Layer, Option, Result, Schedule } from 'effect'
import { Rights } from '../core/auth/index.ts'
import { recordDefect, reportFinding } from '../core/findings/index.ts'
import { Instance } from '../core/instance.ts'
import { exportMarkdown } from './markdown.ts'
import type { ExportOptions } from './markdown.ts'

/** Every night at three, in the server's time zone, unless `EXPORT_SCHEDULE` says otherwise. */
const NIGHTLY = '0 3 * * *'

/**
 * One export, as the server makes it: without sensitive data, and never failing, so the next night
 * comes whatever happened. A failed push is told in the server's output and, when diagnostics are
 * on, as a finding; the commit stays for the next night to push.
 */
export const exportOnce = (options: Omit<ExportOptions, 'sensitive'>) =>
  exportMarkdown({ ...options, sensitive: false }).pipe(
    Effect.provideService(Rights, ['read']),
    Effect.flatMap(({ commit, push }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(commit ?? 'The export found nothing changed.')
        if (push === null || push.pushed) return
        yield* Effect.logError(
          `The push of the export failed: ${push.problem}. The commit stays; the next export pushes it.`,
        )
        if (!(yield* Instance).diagnostics) return
        yield* reportFinding(
          {
            title: 'The push of the nightly export failed',
            kind: 'tool_error',
            place: 'export',
            severity: 'hurts',
            trying: 'Pushing the nightly Markdown export to its remote.',
            happened:
              'The push failed; git gave its reason in the server output. The commit stays in the export folder.',
            expected: 'The export pushed, so the backup outside the server is current.',
          },
          undefined,
          'server',
        )
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError('The export failed.', cause)
        yield* recordDefect('export', cause)
      }),
    ),
  )

/** What the environment asks of the nightly export, if anything. */
const optional = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    // Set to nothing, as in `.env.production.example`, is not set.
    Config.map(Option.filter((value) => value.trim() !== '')),
  )

const settings = Config.all({
  folder: optional('EXPORT_DIR'),
  remote: optional('EXPORT_REMOTE'),
  deployKey: optional('EXPORT_DEPLOY_KEY_FILE'),
  schedule: Config.String('EXPORT_SCHEDULE').pipe(Config.withDefault(NIGHTLY)),
})

/**
 * The nightly export, run inside the server when `EXPORT_DIR` names its folder: into that folder,
 * then pushed to `EXPORT_REMOTE` with the key of `EXPORT_DEPLOY_KEY_FILE`, when they are set, on
 * the cron expression of `EXPORT_SCHEDULE`. Without `EXPORT_DIR`, nothing runs.
 */
export const nightlyExport = Layer.effectDiscard(
  Effect.gen(function* () {
    const { folder, remote, deployKey, schedule } = yield* settings
    if (Option.isNone(folder)) return
    const cron = yield* Result.match(Cron.parse(schedule), {
      onSuccess: Effect.succeed,
      onFailure: () =>
        Effect.fail(
          new Error(
            `EXPORT_SCHEDULE must be a cron expression such as \`${NIGHTLY}\`: \`${schedule}\` is not one.`,
          ),
        ),
    })
    yield* Effect.logInfo(`The Markdown export runs on \`${schedule}\`, into ${folder.value}.`)
    yield* exportOnce({
      folder: folder.value,
      remote: Option.getOrUndefined(remote),
      deployKey: Option.getOrUndefined(deployKey),
    }).pipe(Effect.schedule(Schedule.cron(cron)), Effect.forkScoped)
  }),
)
