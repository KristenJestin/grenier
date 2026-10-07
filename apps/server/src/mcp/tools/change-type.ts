import { ChangeTypeInput, changeType } from '../../core/types/index.ts'
import { Effect } from 'effect'
import { defineTool } from '../tool.ts'

export const changeTypeTool = defineTool({
  name: 'change_type',
  description:
    'Makes a whole type sensitive (a diary, health records): its entries are then shown only to keys with the right `sensitive`; only the owner lifts it, from the command line. Or sets `read_in_parent`: its entries filed under an entry of the same type are read as the parts of their parent, in its page.',
  input: ChangeTypeInput,
  right: 'write',
  run: (input) => Effect.map(changeType(input), (type) => ({ type })),
})
