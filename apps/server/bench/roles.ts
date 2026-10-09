/**
 * What an agent does with Grenier, by role, and the tools that do it today. A task says which roles
 * it needs, never a tool: when the tools are merged or renamed (#169, part 4), this table is the one
 * place to change, and the same tasks measure the new surface.
 */
export const ROLES = [
  'search',
  'read',
  'history',
  'agenda',
  'review',
  'types',
  'rules',
  'references',
  'owner',
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
  history: ['history'],
  agenda: ['upcoming', 'briefing'],
  review: ['unverified'],
  types: ['list_types', 'get_type', 'list_proposals'],
  rules: ['instance_rules'],
  references: ['pending_references'],
  owner: ['confirm_proposal'],
  write: ['write', 'write_many'],
  archive: ['archive'],
  link: ['link', 'unlink'],
  media: ['attach_media', 'describe_media'],
  type_define: ['define_type', 'add_field'],
  type_change: ['change_type', 'change_field', 'propose_type_change'],
  inbox_add: ['inbox_add'],
  inbox_list: ['inbox_list', 'inbox_peek', 'inbox_read'],
  inbox_take: ['inbox_take'],
  inbox_finish: ['inbox_done', 'inbox_dismiss', 'inbox_release'],
}

/**
 * The roles any task may use without that being a wrong choice: looking before acting is what the
 * instructions ask of an agent.
 */
export const LOOKING: ReadonlyArray<Role> = ['search', 'read', 'types', 'rules']

/** The role of a tool, or `undefined` for a tool the table does not know. */
export const roleOf = (tool: string): Role | undefined =>
  ROLES.find((role) => TOOLS_OF[role].includes(tool))
