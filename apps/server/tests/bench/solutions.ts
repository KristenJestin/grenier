import { Effect } from 'effect'
import { archiveEntry, writeEntry } from '../../src/core/entries/index.ts'
import {
  addToInbox,
  dismissItem,
  finishItem,
  listInbox,
  takeItem,
} from '../../src/core/inbox/index.ts'
import { link } from '../../src/core/links/index.ts'
import { addDays } from '../../src/core/time/index.ts'
import { addField, changeField, defineType } from '../../src/core/types/index.ts'
import type { World } from '../../bench/world.ts'

/**
 * What a good run leaves, for each task of the bench, done through the core: the work of the task
 * (as the owner), and the final answer a good agent would give. The checks are proven against it:
 * a check that fails on this is wrong, and one that passes without it asks for nothing.
 */
export type Solution = (world: World) => Promise<string>

export const SOLUTIONS = {
  'recall-graphics-card': async () =>
    'The graphics card is in the Atlas server, bought from Corvid Parts. The server serves the Media streaming setup and the Backup plan.',
  'recall-shop-purchases': async () =>
    'From Corvid Parts: the Graphics card, the Processor and the Power supply, all in the Atlas server.',
  'recall-person-role': async () =>
    'Samir Haddad is a loan officer at Harbor Credit Union. Before, he was a claims adviser at Tidewater Insurance.',
  'recall-lemon-recipes': async () => 'Lemon curd, Lemon-herb chicken and Citrus salad.',
  'recall-contract-end': async ({ today }) =>
    `Your Home internet contract with Skyline Internet ends on ${addDays(today, 2)} and renews tacitly.`,
  'recall-decision-reason': async () =>
    'Snapshots let you restore a single dataset without touching the rest; the file sync tool was set aside.',
  'recall-server-parts': async () =>
    'Graphics card, Processor, Memory kit, System SSD, Server case, Power supply, Cooling fans and Network card.',
  'history-location': async () => 'agent-desk changed it, from garage shelf to hallway cupboard.',
  'due-this-week': async () =>
    'Home internet ends in two days, the Media streaming setup is due in four, and it is the birthday of Maya Okafor in five.',
  overdue: async () => 'Yes: the Home insurance ended three days ago.',
  'contracts-ending-soon': async () =>
    '1. Home internet, 2. Electricity plan, 3. Gym membership, 4. Phone plan.',
  'renewed-contract': async ({ today, arrange }) => {
    await arrange(
      writeEntry({
        entry: 'home-internet',
        fields: { end: addDays(today, 365) },
        provenance: { end: 'inferred' },
      }),
    )
    return 'Done: the contract now ends in a year.'
  },
  'create-recipe': async ({ arrange }) => {
    await arrange(
      writeEntry({
        type: 'recipe',
        title: 'Lemon tart',
        parent: 'kitchen',
        fields: { servings: 8, time_minutes: 90 },
        body: 'Ingredients: 250 g flour, 125 g butter, 100 g sugar, 4 lemons, 3 eggs.\n\nSteps: bake the shell blind for 15 minutes, fill with the lemon cream, bake 20 minutes more.',
        provenance: { servings: 'inferred', time_minutes: 'inferred', body: 'inferred' },
      }),
    )
    return 'The lemon tart is in the Kitchen.'
  },
  'add-disk': async ({ arrange }) => {
    await arrange(
      writeEntry({
        type: 'component',
        title: 'Disk four',
        parent: 'pantry-nas',
        fields: { model: 'Stonewall 4 TB', serial: 'SW-1004' },
        provenance: { model: 'inferred', serial: 'inferred' },
      }),
    )
    await arrange(
      link('disk-four', 'northgate-electronics', 'bought_from', '', '', { provenance: 'inferred' }),
    )
    return 'Added.'
  },
  'fix-serial': async ({ arrange }) => {
    await arrange(
      writeEntry({
        entry: 'processor',
        fields: { serial: 'CV-5522' },
        provenance: { serial: 'inferred' },
      }),
    )
    return 'Corrected.'
  },
  'edit-recipe-time': async ({ arrange }) => {
    await arrange(
      writeEntry({
        entry: 'sourdough-bread',
        edits: [{ find: 'bake 45 minutes', replace: 'bake 50 minutes' }],
        provenance: { body: 'inferred' },
      }),
    )
    return 'Updated.'
  },
  'archive-laptop': async ({ arrange }) => {
    await arrange(archiveEntry('desk-laptop', 'Sold.'))
    return 'Archived.'
  },
  'change-of-job': async ({ arrange }) => {
    await arrange(
      link('nolan-reyes', 'riverside-bakery', 'works_at', '', '', {
        provenance: 'inferred',
        valid_until: '2026-08-31',
      }),
    )
    await arrange(
      link('nolan-reyes', 'tidewater-insurance', 'works_at', '', '', {
        provenance: 'inferred',
        note: 'claims adviser',
        valid_from: '2026-09-01',
      }),
    )
    return 'Recorded.'
  },
  'new-contact': async ({ arrange }) => {
    await arrange(
      writeEntry({
        type: 'person',
        title: 'Priya Nair',
        parent: 'people',
        summary: 'Accountant.',
        provenance: { summary: 'inferred' },
      }),
    )
    await arrange(
      link('priya-nair', 'harbor-credit-union', 'works_at', '', '', {
        provenance: 'inferred',
        note: 'accountant',
        valid_from: '2025-01-15',
      }),
    )
    return 'Added.'
  },
  'relation-between-entries': async ({ arrange }) => {
    await arrange(
      link('media-streaming-setup', 'network-router', 'depends_on', '', '', {
        provenance: 'inferred',
      }),
    )
    return 'Recorded.'
  },
  'replace-decision': async ({ arrange }) => {
    const created = await arrange(
      writeEntry({
        type: 'decision',
        title: 'Replicate to a second NAS',
        parent: 'backup-plan',
        body: 'Replication to a second NAS replaces the snapshots: the monthly offsite trip is too much hassle.',
        provenance: { body: 'inferred' },
      }),
    )
    await arrange(writeEntry({ entry: 'use-zfs-snapshots-for-backups', superseded_by: created.id }))
    return 'Recorded.'
  },
  'bookmark-already-kept': async () => 'That link is already kept, as ZFS basics.',
  'move-part': async ({ arrange }) => {
    await arrange(writeEntry({ entry: 'network-card', parent: 'pantry-nas' }))
    return 'Moved.'
  },
  'note-with-quote': async ({ arrange }) => {
    await arrange(
      writeEntry({
        type: 'note',
        title: 'Worktop quote',
        parent: 'kitchen-renovation',
        body: '[[pine-street-hardware]] quoted 2400 EUR for the worktop, valid until 2026-11-30.',
        provenance: { body: 'inferred' },
      }),
    )
    return 'Noted.'
  },
  'add-field': async ({ arrange }) => {
    await arrange(addField('component', { name: 'warranty_end', kind: 'date' }))
    return 'Added.'
  },
  'new-type': async ({ arrange }) => {
    await arrange(
      defineType({
        name: 'plant',
        label: 'Plant',
        description: 'A houseplant, with where it stands and when it was last watered.',
        fields: [
          { name: 'species', kind: 'text' },
          { name: 'place', kind: 'text' },
          { name: 'last_watered', kind: 'date' },
        ],
      }),
    )
    await arrange(
      writeEntry({
        type: 'plant',
        title: 'Monstera',
        fields: { place: 'living room', last_watered: '2026-10-06' },
        provenance: { place: 'inferred', last_watered: 'inferred' },
      }),
    )
    return 'Set up.'
  },
  'make-field-required': async ({ arrange }) => {
    await arrange(
      changeField({ type: 'contract', field: 'renewal', required: true, default: 'manual' }),
    )
    return 'Done.'
  },
  'inbox-three-items': async ({ arrange }) => {
    const { items } = await arrange(listInbox({}))
    await arrange(Effect.forEach(items, ({ id }) => takeItem({ id })))
    const [hummus, update, page] = items
    if (hummus === undefined || update === undefined || page === undefined) return 'missing'
    await arrange(
      writeEntry({
        type: 'recipe',
        title: 'Hummus',
        parent: 'kitchen',
        fields: { servings: 4, time_minutes: 10 },
        body: 'Blend 400 g chickpeas, 2 tbsp tahini, lemon juice and garlic.',
        provenance: { servings: 'inferred', time_minutes: 'inferred', body: 'inferred' },
      }),
    )
    await arrange(
      writeEntry({
        entry: 'disk-three',
        fields: { serial: 'SW-2003' },
        provenance: { serial: 'inferred' },
      }),
    )
    await arrange(
      writeEntry({
        type: 'bookmark',
        title: 'ZFS snapshots deep dive',
        parent: 'reading',
        fields: { url: 'https://example.org/guides/zfs-snapshots-deep-dive' },
        provenance: { url: 'inferred' },
      }),
    )
    await arrange(finishItem({ id: hummus.id, entries: ['hummus'] }))
    await arrange(finishItem({ id: update.id, entries: ['disk-three'] }))
    await arrange(finishItem({ id: page.id, entries: ['zfs-snapshots-deep-dive'] }))
    return 'All three are filed.'
  },
  'inbox-set-aside-junk': async ({ arrange }) => {
    const { items } = await arrange(listInbox({}))
    const [pesto, junk] = items
    if (pesto === undefined || junk === undefined) return 'missing'
    await arrange(Effect.forEach([pesto, junk], ({ id }) => takeItem({ id })))
    await arrange(
      writeEntry({
        type: 'recipe',
        title: 'Pesto',
        parent: 'kitchen',
        fields: { servings: 4 },
        body: 'Crush basil, pine nuts, parmesan and olive oil.',
        provenance: { servings: 'inferred', body: 'inferred' },
      }),
    )
    await arrange(finishItem({ id: pesto.id, entries: ['pesto'] }))
    await arrange(dismissItem({ id: junk.id, reason: 'Not a note: random keys.' }))
    return 'Filed the pesto, set aside the junk.'
  },
  'inbox-capture': async ({ arrange }) => {
    await arrange(
      addToInbox({
        kind: 'url',
        url: 'https://example.org/articles/rack-cooling',
        origin: 'newsletter',
      }),
    )
    return 'It is in your inbox.'
  },
  'supposed-queue': async () =>
    'Four entries wait: Router settings, Cable management ideas, Lemon curd and Flatbreads.',
  'nothing-known': async () => 'I found nothing about a wifi password at the cabin.',
  'resume-discussion': async () =>
    'We were talking about the Pantry NAS disk replacement: the Halden 8 TB is chosen, and the next step is the warranty claim.',
  'vague-music-thing': async () =>
    'Three things could be the music thing: Music library tagging, Music lessons schedule and Music festival tickets. Which one do you mean?',
  'link-two-by-title': async ({ arrange }) => {
    await arrange(
      writeEntry({
        type: 'note',
        title: 'Saturday tinkering',
        summary: 'Tidying the cables behind the Network router; Samir Haddad came by.',
        body: 'I spent the afternoon tidying the cables behind the [[network-router]], and [[samir-haddad]] came by for a coffee.',
        provenance: { body: 'inferred', summary: 'inferred' },
      }),
    )
    return 'Added.'
  },
} satisfies { readonly [task: string]: Solution }
