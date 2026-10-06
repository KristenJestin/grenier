import baseline from './0001_baseline.ts'
import types from './0002_types.ts'
import entries from './0003_entries.ts'
import events from './0004_events.ts'
import links from './0005_links.ts'
import search from './0006_search.ts'
import sources from './0007_sources.ts'
import auth from './0008_auth.ts'
import time from './0009_time.ts'
import typeChanges from './0010_type_changes.ts'
import media from './0011_media.ts'
import fulfillsField from './0012_fulfills_field.ts'

/** Every migration, keyed `<id>_<name>`; the runner applies them in id order, once each. */
export const migrations = {
  '0001_baseline': baseline,
  '0002_types': types,
  '0003_entries': entries,
  '0004_events': events,
  '0005_links': links,
  '0006_search': search,
  '0007_sources': sources,
  '0008_auth': auth,
  '0009_time': time,
  '0010_type_changes': typeChanges,
  '0011_media': media,
  '0012_fulfills_field': fulfillsField,
}
