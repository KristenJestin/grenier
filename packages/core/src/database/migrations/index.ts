import baseline from './0001_baseline.ts'

/** Every migration, keyed `<id>_<name>`; the runner applies them in id order, once each. */
export const migrations = {
  '0001_baseline': baseline,
}
