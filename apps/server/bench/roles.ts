/**
 * What an agent does with Grenier, by role, and the tools that do it today. A task says which roles
 * it needs, never a tool: when the tools are merged or renamed, this table is the one place to
 * change, and the same tasks measure the new surface. Since #169 part 4 a tool may serve several
 * roles (`write` writes and archives, `read` reads and gives the history).
 */
export const ROLES = [
  'search',
  'read',
  'history',
  'agenda',
  'supposed',
  'types',
  'rules',
  'references',
  'write',
  'archive',
  'link',
  'media',
  'type_define',
  'type_change',
  'inbox_add',
  'inbox_list',
  'inbox_take',
  'inbox_finish',
] as const
export type Role = (typeof ROLES)[number]

/** The tools of each role, by the name the server gives them (without the MCP prefix). */
export const TOOLS_OF: Readonly<Record<Role, ReadonlyArray<string>>> = {
  search: ['search'],
  read: ['read'],
  history: ['read'],
  agenda: ['briefing'],
  supposed: ['search', 'briefing'],
  types: ['types'],
  rules: ['types'],
  references: ['briefing'],
  write: ['write'],
  archive: ['write'],
  link: ['link'],
  media: ['attach_media'],
  type_define: ['define_type'],
  type_change: ['change_type'],
  inbox_add: ['inbox_add'],
  inbox_list: ['inbox_list'],
  inbox_take: ['inbox_take'],
  inbox_finish: ['inbox_finish'],
}

/**
 * The roles any task may use without that being a wrong choice: looking before acting is what the
 * instructions ask of an agent.
 */
export const LOOKING: ReadonlyArray<Role> = ['search', 'read', 'types', 'rules']

/** The roles of a tool, none for a tool the table does not know. */
export const rolesOf = (tool: string): ReadonlyArray<Role> =>
  ROLES.filter((role) => TOOLS_OF[role].includes(tool))
