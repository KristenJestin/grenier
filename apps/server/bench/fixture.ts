import type { TypeDefinition, WriteEntryInput } from '@grenier/api/model'
import { Auth, Rights } from '../src/core/auth/index.ts'
import { slugOf, writeEntries, writeEntry } from '../src/core/entries/index.ts'
import { Actor } from '../src/core/events/index.ts'
import { link } from '../src/core/links/index.ts'
import { setInstanceRules } from '../src/core/rules.ts'
import { addDays } from '../src/core/time/index.ts'
import { defineType } from '../src/core/types/index.ts'
import { Effect } from 'effect'

/**
 * The invented instance every task starts from: about a hundred entries (a home server and its
 * parts, the shops they came from, the projects they serve, people and organizations, recipes,
 * contracts with deadlines, bookmarks and notes), the types they follow, the rules of the
 * instance, and the links between them. Nothing here is real: names, shops, addresses and amounts
 * are made up. Dates that matter to a task are relative to the day of the run, so "due this week"
 * stays true.
 */

/** The key the agent under measurement uses; its name is the actor of what it writes. */
export const AGENT_KEY = 'bench-agent'

/** The rights of that key: what a capture-and-recall assistant is given. */
export const AGENT_RIGHTS = ['read', 'write'] as const

/** The rules the owner of the instance gave every agent. */
export const RULES = `# Rules of this instance

- Write in English.
- A title names the thing and never repeats the name of its parent: "Graphics card", not "Graphics card of the server".
- Recipes are filed under the Kitchen area. Machines and their parts are filed under the Home lab area. Contracts are filed under the Finance area. People and organizations are filed under the People area. Shops, projects and bookmarks stay where they are asked to.
- Dates are written 2026-10-05, amounts with their currency (12.50 EUR).
`

const text = (name: string) => ({ name, kind: 'text' as const })

/** The types of the instance, with a description that says when to use each. */
export const TYPES: ReadonlyArray<typeof TypeDefinition.Encoded> = [
  {
    name: 'area',
    label: 'Area',
    description:
      'A grouping of entries by domain (the Kitchen, the Home lab, Finance): use it to file entries together; it has no fields of its own.',
    fields: [],
  },
  {
    name: 'machine',
    label: 'Machine',
    description:
      'A computer, server or storage box of the household. Its parts are components, filed under it.',
    fields: [text('role'), text('location'), { name: 'acquired', kind: 'date' }],
  },
  {
    name: 'component',
    label: 'Component',
    description:
      'A part of a machine (a graphics card, a disk, a memory kit), filed under the machine it is installed in.',
    fields: [text('model'), text('serial'), { name: 'installed', kind: 'date' }],
  },
  {
    name: 'shop',
    label: 'Shop',
    description: 'A shop or supplier something was bought from.',
    fields: [{ name: 'website', kind: 'url' }],
  },
  {
    name: 'organization',
    label: 'Organization',
    description: 'A company, a cooperative, a bank or any body people work for or belong to.',
    fields: [text('sector')],
  },
  {
    name: 'person',
    label: 'Person',
    description:
      'A person the owner knows. Where and as what they work is a link to an organization, with a role and dates.',
    fields: [{ name: 'birthday', kind: 'date', recurs: { every: 'yearly', notice: 'P7D' } }],
  },
  {
    name: 'project',
    label: 'Project',
    description:
      'A project with a goal and an end. It is the record of the project and holds its notes and decisions.',
    fields: [
      { name: 'status', kind: 'enum', values: ['active', 'paused', 'done'] },
      { name: 'deadline', kind: 'date', due: { notice: 'P7D' } },
    ],
  },
  {
    name: 'recipe',
    label: 'Recipe',
    description: 'A cooking recipe: ingredients and steps in the body.',
    fields: [
      { name: 'servings', kind: 'integer' },
      { name: 'time_minutes', kind: 'integer' },
    ],
  },
  {
    name: 'contract',
    label: 'Contract',
    description: 'A contract or subscription followed over time, with its provider and its end.',
    fields: [
      { name: 'provider', kind: 'entry', types: ['organization'], required: true },
      { name: 'start', kind: 'date', required: true },
      { name: 'end', kind: 'date', due: { notice: 'P14D' } },
      { name: 'renewal', kind: 'enum', values: ['tacit', 'manual', 'none'] },
      { name: 'monthly_cost', kind: 'money' },
    ],
  },
  {
    name: 'bookmark',
    label: 'Bookmark',
    description: 'A web page kept for later, with what it is good for.',
    fields: [{ name: 'url', kind: 'url', required: true }],
  },
  {
    name: 'decision',
    label: 'Decision',
    description: 'A decision taken, with its reasons and the options set aside.',
    fields: [{ name: 'decided_on', kind: 'date' }],
  },
  {
    name: 'note',
    label: 'Note',
    description: 'A free note that fits no other type.',
    fields: [],
  },
]

type Spec = WriteEntryInput & { readonly title: string; readonly type: string }

const area = (title: string, summary: string): Spec => ({ type: 'area', title, summary })

/** The days from today to each date a task cares about. */
export const DAYS = {
  internetEnds: 2,
  streamingDeadline: 4,
  birthdayMaya: 5,
  electricityEnds: 12,
  birthdayTomas: 14,
  gymEnds: 20,
  phoneEnds: 45,
  kitchenDeadline: 60,
  bankEnds: 100,
  carInsuranceEnds: 200,
  waterEnds: 300,
  homeInsuranceEnded: -3,
} as const

/** Same month and day as `day`, in a year long ago: a birthday. */
const birthdayOn = (day: string, year: number) => `${year}${day.slice(4)}`

const component = (
  title: string,
  parent: string,
  model: string,
  serial: string,
  summary: string,
  installed: string,
): Spec => ({
  type: 'component',
  title,
  parent,
  summary,
  fields: { model, serial, installed },
})

const recipe = (
  title: string,
  servings: number,
  minutes: number,
  summary: string,
  body: string,
): Spec => ({
  type: 'recipe',
  title,
  parent: 'kitchen',
  summary,
  fields: { servings, time_minutes: minutes },
  body,
})

const bookmark = (title: string, url: string, summary: string): Spec => ({
  type: 'bookmark',
  title,
  parent: 'reading',
  summary,
  fields: { url },
})

const person = (title: string, summary: string, birthday?: string): Spec => ({
  type: 'person',
  title,
  parent: 'people',
  summary,
  fields: birthday === undefined ? {} : { birthday },
})

const organization = (title: string, sector: string, summary: string): Spec => ({
  type: 'organization',
  title,
  parent: 'people',
  summary,
  fields: { sector },
})

const contract = (
  title: string,
  provider: string,
  start: string,
  end: string,
  renewal: string | undefined,
  cost: string,
  summary: string,
): Spec => {
  const kept = { provider, start, end, monthly_cost: cost }
  const fields = renewal === undefined ? kept : { ...kept, renewal }
  return { type: 'contract', title, parent: 'finance', summary, fields }
}

const note = (title: string, parent: string | undefined, summary: string, body: string): Spec =>
  parent === undefined
    ? { type: 'note', title, summary, body }
    : { type: 'note', title, parent, summary, body }

/** Every entry of the instance, parents before their children, as dated from `today`. */
export const entriesFor = (today: string): ReadonlyArray<Spec> => {
  const day = (days: number) => addDays(today, days)
  return [
    area('Home lab', 'Machines of the household and their parts.'),
    area('Kitchen', 'Recipes and cooking notes.'),
    area('Finance', 'Contracts, insurance and bank products.'),
    area('People', 'People and organizations the owner deals with.'),
    area('Reading', 'Web pages kept for later.'),

    {
      type: 'machine',
      title: 'Atlas server',
      parent: 'home-lab',
      summary: 'The home server that hosts the media library and the nightly backups.',
      fields: { role: 'media and backups', location: 'study', acquired: '2025-11-08' },
      body: 'Built in autumn 2025 from parts bought online. It runs all day and serves the media streaming setup.',
    },
    {
      type: 'machine',
      title: 'Pantry NAS',
      parent: 'home-lab',
      summary: 'Network storage box that holds the backups.',
      fields: { role: 'backup storage', location: 'garage shelf', acquired: '2024-04-20' },
      body: 'Three disks in a mirror plus spare. Receives the snapshots of the Atlas server every night.',
    },
    {
      type: 'machine',
      title: 'Desk laptop',
      parent: 'home-lab',
      summary: 'Old laptop kept for guests; due to be sold.',
      fields: { role: 'guest laptop', location: 'study', acquired: '2019-02-14' },
    },
    {
      type: 'machine',
      title: 'Network router',
      parent: 'home-lab',
      summary: 'Router and switch of the household network.',
      fields: { role: 'network', location: 'hall', acquired: '2023-06-01' },
    },

    component(
      'Graphics card',
      'atlas-server',
      'Vireo RX 640',
      'VR-1138',
      'Graphics card of the Atlas server, used for video transcoding.',
      '2025-11-12',
    ),
    component(
      'Processor',
      'atlas-server',
      'Corvid 12-core',
      'CV-5521',
      '12-core processor of the Atlas server.',
      '2025-11-09',
    ),
    component(
      'Memory kit',
      'atlas-server',
      'Northgate 2x16 GB',
      'NG-3304',
      '32 GB of memory in two modules.',
      '2025-11-09',
    ),
    component(
      'System SSD',
      'atlas-server',
      'Northgate 1 TB NVMe',
      'NG-7712',
      'Boot and application disk of the Atlas server.',
      '2025-11-10',
    ),
    component(
      'Server case',
      'atlas-server',
      'Pine tower',
      'PT-0098',
      'Tower case with room for four disks.',
      '2025-11-08',
    ),
    component(
      'Power supply',
      'atlas-server',
      'Corvid 650 W',
      'CV-2210',
      '650 W power supply, gold rated.',
      '2025-11-09',
    ),
    component(
      'Cooling fans',
      'atlas-server',
      'Bluefin quiet 120 mm x3',
      'BF-4410',
      'Three quiet case fans.',
      '2025-11-11',
    ),
    component(
      'Network card',
      'atlas-server',
      'Bluefin 2.5 Gb',
      'BF-8830',
      'Dual 2.5 Gb network card.',
      '2025-11-11',
    ),
    component(
      'Disk one',
      'pantry-nas',
      'Stonewall 4 TB',
      'SW-1001',
      'First 4 TB disk of the NAS mirror.',
      '2024-04-21',
    ),
    component(
      'Disk two',
      'pantry-nas',
      'Stonewall 4 TB',
      'SW-1002',
      'Second 4 TB disk of the NAS mirror.',
      '2024-04-21',
    ),
    component(
      'Disk three',
      'pantry-nas',
      'Stonewall 4 TB',
      'SW-1003',
      'Spare 4 TB disk of the NAS.',
      '2024-09-30',
    ),
    component(
      'Laptop battery',
      'desk-laptop',
      'LB-45',
      'LB-0007',
      'Battery of the desk laptop, holds about an hour.',
      '2022-03-03',
    ),
    component(
      'Laptop memory',
      'desk-laptop',
      'Northgate 8 GB',
      'NG-0042',
      'Single 8 GB memory module.',
      '2019-02-14',
    ),
    component(
      'Router unit',
      'network-router',
      'Lumen AX-3',
      'LM-3301',
      'The router unit itself.',
      '2023-06-01',
    ),
    component(
      'Network switch',
      'network-router',
      'Bluefin 8-port',
      'BF-0815',
      'Eight-port gigabit switch.',
      '2023-06-01',
    ),

    {
      type: 'shop',
      title: 'Corvid Parts',
      summary: 'Online shop for processors, power supplies and boards.',
      fields: { website: 'https://corvid-parts.example.org' },
    },
    {
      type: 'shop',
      title: 'Northgate Electronics',
      summary: 'Electronics shop; memory, disks and drives.',
      fields: { website: 'https://northgate.example.org' },
    },
    {
      type: 'shop',
      title: 'Bluefin Cables',
      summary: 'Specialist shop for cables, fans and network gear.',
      fields: { website: 'https://bluefin.example.org' },
    },
    {
      type: 'shop',
      title: 'Pine Street Hardware',
      summary: 'Local hardware store; cases, tools and building supplies.',
      fields: { website: 'https://pinestreet.example.org' },
    },
    {
      type: 'shop',
      title: 'Orchard Market',
      summary: 'Grocery market with a good fruit counter.',
      fields: { website: 'https://orchard-market.example.org' },
    },
    {
      type: 'shop',
      title: 'Willow Books',
      summary: 'Independent bookshop that also orders magazines.',
      fields: { website: 'https://willow-books.example.org' },
    },

    {
      type: 'project',
      title: 'Media streaming setup',
      summary: 'Serve the family media library to every screen in the house from the Atlas server.',
      fields: { status: 'active', deadline: day(DAYS.streamingDeadline) },
      body: 'Goal: one place for music, films and photos, reachable from the living room and from phones.',
    },
    {
      type: 'project',
      title: 'Backup plan',
      summary: 'Nightly snapshots of the Atlas server to the Pantry NAS and one offsite copy.',
      fields: { status: 'active' },
      body: 'Snapshots every night, kept thirty days; a copy leaves the house once a month.',
    },
    {
      type: 'project',
      title: 'Kitchen renovation',
      summary: 'Replace the worktop and tiles of the kitchen before the end of the year.',
      fields: { status: 'active', deadline: day(DAYS.kitchenDeadline) },
    },
    {
      type: 'project',
      title: 'Garden shed',
      summary: 'Build a small shed for tools; on hold until spring.',
      fields: { status: 'paused' },
    },

    {
      type: 'note',
      title: 'Living room screen plan',
      parent: 'media-streaming-setup',
      summary: 'Which screens will play from the media library, and how they connect.',
      body: 'Two televisions and one projector. The projector needs a small player box.',
    },
    {
      type: 'note',
      title: 'Library folder layout',
      parent: 'media-streaming-setup',
      summary: 'How the media folders are organised on the Atlas server.',
      body: 'Music, films, series and photos each have a folder; photos are grouped by year.',
    },
    {
      type: 'decision',
      title: 'Use ZFS snapshots for backups',
      parent: 'backup-plan',
      summary: 'Backups are filesystem snapshots, chosen over a file sync tool.',
      fields: { decided_on: '2026-03-12' },
      body: 'Chosen because snapshots are cheap to keep and a single dataset can be restored without touching the rest. The file sync tool was set aside: it copies mistakes as faithfully as good files.',
    },
    {
      type: 'decision',
      title: 'Keep one offsite copy',
      parent: 'backup-plan',
      summary: 'One monthly copy leaves the house, to a friend with a spare drive.',
      fields: { decided_on: '2026-04-02' },
      body: 'A cloud service was set aside because of the cost per terabyte.',
    },
    note(
      'Restore test log',
      'backup-plan',
      'Results of the restore tests of the backups.',
      '2026-06-14: restored one dataset in twelve minutes. Nothing missing.',
    ),
    note(
      'Tile samples',
      'kitchen-renovation',
      'Tile samples looked at in the shop.',
      'Three samples: matte white, sage green, sand. The sage green looked best in daylight.',
    ),
    {
      type: 'decision',
      title: 'Pick matte tiles',
      parent: 'kitchen-renovation',
      summary: 'Matte tiles for the kitchen wall.',
      fields: { decided_on: '2026-09-02' },
      body: 'Matte hides fingerprints. Glossy tiles were set aside.',
    },
    note(
      'Shed plan sketch',
      'garden-shed',
      'First sketch of the shed.',
      'Two by three metres, a sloped roof, a door facing the house.',
    ),

    person(
      'Maya Okafor',
      'Treasurer of the Lakeside Cooperative.',
      birthdayOn(day(DAYS.birthdayMaya), 1988),
    ),
    person('Nolan Reyes', 'Baker; a neighbour.', birthdayOn(day(150), 1992)),
    person('Samir Haddad', 'Loan officer; handles the mortgage file.', birthdayOn(day(90), 1984)),
    person('Elena Brandt', 'Support lead at the internet provider.', birthdayOn(day(250), 1990)),
    person('Tomas Vidal', 'Old friend; lives abroad.', birthdayOn(day(DAYS.birthdayTomas), 1986)),
    person(
      'Ingrid Solberg',
      'Carpenter who gave a quote for the shed.',
      birthdayOn(day(120), 1979),
    ),
    person('Kwame Mensah', 'Colleague from the previous job.', birthdayOn(day(200), 1983)),
    person('Lucia Ferrante', 'Piano teacher of the family.', birthdayOn(day(75), 1995)),
    person('Hana Sato', 'Neighbour with a garden.'),
    person('Leo Marchetti', 'Plumber, recommended by a neighbour.'),
    person('Grace Lindqvist', 'Neighbour who waters the plants in summer.'),
    person('Omar Faridi', 'Friend who lends tools.'),
    person('Sofia Keller', 'Colleague who recommended the baker.'),

    organization(
      'Lakeside Cooperative',
      'cooperative',
      'Neighbourhood cooperative with a gym and a shared garden.',
    ),
    organization('Tidewater Insurance', 'insurance', 'Insurer of the house and the car.'),
    organization('Harbor Credit Union', 'bank', 'The bank holding the accounts and the mortgage.'),
    organization('Skyline Internet', 'telecom', 'Internet and phone provider.'),
    organization('Greenfield Energy', 'utility', 'Supplier of electricity and water.'),
    organization('Riverside Bakery', 'food', 'Bakery on the corner; Nolan works there.'),

    contract(
      'Home internet',
      'skyline-internet',
      '2024-10-12',
      day(DAYS.internetEnds),
      'tacit',
      '39.90 EUR',
      'Fibre internet at home; ends in a few days.',
    ),
    contract(
      'Home insurance',
      'tidewater-insurance',
      '2025-10-06',
      day(DAYS.homeInsuranceEnded),
      'manual',
      '18.40 EUR',
      'Insurance of the house; the term ended and has not been dealt with.',
    ),
    contract(
      'Electricity plan',
      'greenfield-energy',
      '2025-10-21',
      day(DAYS.electricityEnds),
      'tacit',
      '64.00 EUR',
      'Electricity supply plan with a fixed price.',
    ),
    contract(
      'Gym membership',
      'lakeside-cooperative',
      '2025-10-29',
      day(DAYS.gymEnds),
      'tacit',
      '24.00 EUR',
      'Membership of the cooperative gym.',
    ),
    contract(
      'Phone plan',
      'skyline-internet',
      '2025-11-23',
      day(DAYS.phoneEnds),
      undefined,
      '12.00 EUR',
      'Mobile phone plan.',
    ),
    contract(
      'Bank account package',
      'harbor-credit-union',
      '2024-01-18',
      day(DAYS.bankEnds),
      undefined,
      '6.50 EUR',
      'Current account with two cards.',
    ),
    contract(
      'Car insurance',
      'tidewater-insurance',
      '2026-04-23',
      day(DAYS.carInsuranceEnds),
      'manual',
      '41.20 EUR',
      'Insurance of the family car.',
    ),
    contract(
      'Water supply',
      'greenfield-energy',
      '2026-08-02',
      day(DAYS.waterEnds),
      'tacit',
      '22.10 EUR',
      'Water supply contract.',
    ),

    recipe(
      'Sourdough bread',
      2,
      45 + 240,
      'Country loaf with a long rise.',
      'Ingredients: 500 g flour, 350 g water, 100 g starter, 10 g salt.\n\nSteps: mix, rest four hours with folds, shape, bake 45 minutes in a hot pot.',
    ),
    recipe(
      'Lemon curd',
      6,
      20,
      'Tangy lemon spread for tarts and toast.',
      'Ingredients: 4 lemons, 150 g sugar, 100 g butter, 3 eggs.\n\nSteps: whisk over low heat until thick, sieve, chill.',
    ),
    recipe(
      'Lemon-herb chicken',
      4,
      60,
      'Roast chicken with lemon and thyme.',
      'Ingredients: 1 chicken, 2 lemons, thyme, garlic, olive oil.\n\nSteps: rub, roast one hour, rest ten minutes.',
    ),
    recipe(
      'Citrus salad',
      4,
      15,
      'Fresh salad of oranges, grapefruit and lemon zest.',
      'Ingredients: 3 oranges, 1 grapefruit, zest of one lemon, mint.\n\nSteps: slice, toss, chill.',
    ),
    recipe(
      'Lentil soup',
      4,
      40,
      'Thick soup with red lentils and cumin.',
      'Ingredients: 250 g red lentils, 1 onion, cumin, stock.\n\nSteps: sweat the onion, simmer with lentils, blend half.',
    ),
    recipe(
      'Pumpkin risotto',
      4,
      45,
      'Creamy risotto with roast pumpkin.',
      'Ingredients: 300 g rice, 400 g pumpkin, stock, parmesan.\n\nSteps: roast pumpkin, stir rice with stock, fold in.',
    ),
    recipe(
      'Apple crumble',
      6,
      50,
      'Warm apple dessert with an oat topping.',
      'Ingredients: 6 apples, 100 g oats, 80 g butter, cinnamon.\n\nSteps: slice, top, bake 35 minutes.',
    ),
    recipe(
      'Shakshuka',
      2,
      25,
      'Eggs poached in spiced tomato sauce.',
      'Ingredients: tomatoes, peppers, 4 eggs, paprika.\n\nSteps: simmer sauce, poach eggs.',
    ),
    recipe(
      'Plum jam',
      8,
      90,
      'Jam from the late plums.',
      'Ingredients: 1 kg plums, 600 g sugar.\n\nSteps: cook until it sets, jar hot.',
    ),
    recipe(
      'Flatbreads',
      6,
      30,
      'Quick yeast-free flatbreads.',
      'Ingredients: 300 g flour, yoghurt, salt.\n\nSteps: knead, rest, fry.',
    ),
    recipe(
      'Banana bread',
      8,
      65,
      'Moist loaf from overripe bananas.',
      'Ingredients: 3 bananas, 200 g flour, 100 g sugar, 2 eggs.\n\nSteps: mash, mix, bake.',
    ),
    recipe(
      'Tomato sauce',
      6,
      60,
      'Basic sauce made in large batches.',
      'Ingredients: 2 kg tomatoes, onion, basil.\n\nSteps: cook down, blend, freeze.',
    ),
    recipe(
      'Pancakes',
      4,
      20,
      'Thin pancakes for Sunday mornings.',
      'Ingredients: 250 g flour, 3 eggs, 500 ml milk.\n\nSteps: whisk, rest, fry.',
    ),
    recipe(
      'Chickpea chili',
      4,
      45,
      'Vegetarian chili with chickpeas and smoked paprika.',
      'Ingredients: chickpeas, tomatoes, smoked paprika, beans.\n\nSteps: simmer forty minutes.',
    ),

    bookmark(
      'ZFS basics',
      'https://example.org/guides/zfs-basics',
      'Introduction to datasets and snapshots.',
    ),
    bookmark(
      'Home network diagrams',
      'https://example.org/guides/home-network-diagrams',
      'How to draw a home network.',
    ),
    bookmark(
      'Sourdough starter guide',
      'https://example.org/guides/sourdough-starter',
      'Keeping a starter alive.',
    ),
    bookmark('Tile care tips', 'https://example.org/guides/tile-care', 'Cleaning matte tiles.'),
    bookmark(
      'Backup strategies explained',
      'https://example.org/guides/backup-strategies',
      'The 3-2-1 rule and variations.',
    ),
    bookmark(
      'Cable management ideas',
      'https://example.org/guides/cable-management',
      'Tidy cabling in a rack.',
    ),
    bookmark(
      'Shed foundations',
      'https://example.org/guides/shed-foundations',
      'Slab, blocks or piles for a small shed.',
    ),
    bookmark(
      'Rack cooling basics',
      'https://example.org/guides/rack-cooling-basics',
      'Airflow in a small rack.',
    ),
    bookmark(
      'Photo backup workflow',
      'https://example.org/guides/photo-backup',
      'Keeping family photos safe.',
    ),
    bookmark(
      'Worktop materials compared',
      'https://example.org/guides/worktop-materials',
      'Wood, stone and laminate.',
    ),

    note(
      'Offsite drive log',
      'backup-plan',
      'When the offsite drive was swapped.',
      'Swapped on the first Sunday of each month.',
    ),
    note(
      'Worktop options',
      'kitchen-renovation',
      'Worktop materials considered.',
      'Oak, granite and laminate; oak is the favourite.',
    ),
    note(
      'Player box shortlist',
      'media-streaming-setup',
      'Boxes considered for the projector.',
      'Three small boxes with the same chip; the cheapest has no network port.',
    ),
    note(
      'Router settings',
      'home-lab',
      'Settings of the router that are worth remembering.',
      'The guest network is on its own VLAN. The admin page is only reachable from the study.',
    ),
    note(
      'Gift ideas',
      'people',
      'Gift ideas by person.',
      'Maya: a good notebook. Tomas: a book from Willow Books.',
    ),
    note(
      'Moving checklist',
      undefined,
      'Checklist for the move planned next year.',
      'Forward the mail, cancel the internet contract, measure the new kitchen.',
    ),
    note(
      'Winter pantry list',
      'kitchen',
      'Staples to keep in stock in winter.',
      'Lentils, rice, tinned tomatoes, flour, oats.',
    ),
  ]
}

/** A link of the instance: who, to whom, how, and what it says of itself. */
type Seeded = {
  readonly from: string
  readonly to: string
  readonly relation: string
  readonly note?: string
  readonly valid_from?: string
  readonly valid_until?: string
}

/** The links of the instance between its entries. */
export const LINKS: ReadonlyArray<Seeded> = [
  {
    from: 'graphics-card',
    to: 'corvid-parts',
    relation: 'bought_from',
    note: 'graphics card, ordered 2025-11',
  },
  { from: 'processor', to: 'corvid-parts', relation: 'bought_from', note: 'processor' },
  { from: 'power-supply', to: 'corvid-parts', relation: 'bought_from', note: 'power supply' },
  { from: 'memory-kit', to: 'northgate-electronics', relation: 'bought_from', note: 'memory kit' },
  { from: 'system-ssd', to: 'northgate-electronics', relation: 'bought_from', note: 'system disk' },
  { from: 'disk-one', to: 'northgate-electronics', relation: 'bought_from', note: 'disk' },
  { from: 'disk-two', to: 'northgate-electronics', relation: 'bought_from', note: 'disk' },
  { from: 'disk-three', to: 'northgate-electronics', relation: 'bought_from', note: 'spare disk' },
  { from: 'cooling-fans', to: 'bluefin-cables', relation: 'bought_from', note: 'fans' },
  { from: 'network-card', to: 'bluefin-cables', relation: 'bought_from', note: 'network card' },
  { from: 'network-switch', to: 'bluefin-cables', relation: 'bought_from', note: 'switch' },
  { from: 'server-case', to: 'pine-street-hardware', relation: 'bought_from', note: 'case' },
  {
    from: 'atlas-server',
    to: 'media-streaming-setup',
    relation: 'serves',
    note: 'hosts the media library',
  },
  {
    from: 'pantry-nas',
    to: 'backup-plan',
    relation: 'serves',
    note: 'holds the nightly snapshots',
  },
  { from: 'atlas-server', to: 'backup-plan', relation: 'serves', note: 'source of the snapshots' },
  {
    from: 'maya-okafor',
    to: 'lakeside-cooperative',
    relation: 'works_at',
    note: 'treasurer',
    valid_from: '2023-02-01',
  },
  {
    from: 'nolan-reyes',
    to: 'riverside-bakery',
    relation: 'works_at',
    note: 'baker',
    valid_from: '2022-05-02',
  },
  {
    from: 'samir-haddad',
    to: 'harbor-credit-union',
    relation: 'works_at',
    note: 'loan officer',
    valid_from: '2020-09-01',
  },
  {
    from: 'samir-haddad',
    to: 'tidewater-insurance',
    relation: 'works_at',
    note: 'claims adviser',
    valid_from: '2016-01-01',
    valid_until: '2020-08-31',
  },
  {
    from: 'elena-brandt',
    to: 'skyline-internet',
    relation: 'works_at',
    note: 'support lead',
    valid_from: '2021-03-15',
  },
  { from: 'ingrid-solberg', to: 'garden-shed', relation: 'about', note: 'gave a quote' },
]

/**
 * Entries whose values the import agent only supposed: they hold `inferred` values, and wait for
 * the owner to confirm them. Every other entry is known, read in the notes the owner gave.
 */
export const SUPPOSED = ['router-settings', 'cable-management-ideas', 'lemon-curd', 'flatbreads']

/** Where the import agent read what it wrote: a source for each entry it knows something of. */
const NOTES = { identifier: 'owner-notes-2026', label: 'notes the owner handed over' } as const

/**
 * An entry as the import agent writes it: every value, its body and its summary say whether they
 * are known (`extracted` from the owner's notes, which the entry then cites) or, for the entries
 * of `SUPPOSED`, supposed (`inferred`).
 */
export const asImported = (spec: Spec): Spec => {
  const slug = spec.slug ?? slugOf(spec.title)
  const provenance = SUPPOSED.includes(slug) ? 'inferred' : 'extracted'
  const said = [
    ...Object.keys(spec.fields ?? {}),
    ...(spec.body === undefined || spec.body === '' ? [] : ['body']),
    ...(spec.summary === undefined || spec.summary === '' ? [] : ['summary']),
  ]
  return {
    ...spec,
    provenance: Object.fromEntries(said.map((name) => [name, provenance])),
    sources: spec.sources ?? [NOTES],
  }
}

const OWNER = ['read', 'write', 'sensitive', 'owner'] as const

const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Actor, 'owner'), Effect.provideService(Rights, OWNER))

/** Runs as the import agent that wrote the instance's entries. */
const asImporter = <A, E, R>(effect: Effect.Effect<A, E, R>, actor = 'import-agent') =>
  effect.pipe(
    Effect.provideService(Actor, actor),
    Effect.provideService(Rights, ['read', 'write'] as const),
  )

/**
 * Writes the instance into an empty, migrated database through the core: the owner and the key
 * of the agent under measurement, the rules, the types, the entries, the links, a change of
 * location by another agent (for the history). Every value says whether it is known or supposed
 * (see `asImported`). Returns the secret of the key.
 */
export const seedInstance = (today: string) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    yield* auth.createOwner('owner@example.org', 'Owner')
    const { secret } = yield* auth.createKey(AGENT_KEY, [...AGENT_RIGHTS])
    yield* asOwner(setInstanceRules(RULES))
    yield* asImporter(
      Effect.gen(function* () {
        for (const type of TYPES) yield* defineType(type)
        yield* writeEntries(entriesFor(today).map(asImported))
        for (const each of LINKS) {
          yield* link(each.from, each.to, each.relation, '', '', {
            provenance: 'extracted',
            note: each.note,
            valid_from: each.valid_from,
            valid_until: each.valid_until,
          })
        }
      }),
    )
    yield* asImporter(
      writeEntry({
        entry: 'pantry-nas',
        fields: { location: 'hallway cupboard' },
        provenance: { location: 'extracted' },
      }),
      'agent-desk',
    )
    return secret
  })
