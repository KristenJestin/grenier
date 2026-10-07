import { ChangeTypeInput, changeType } from '../../core/types/index.ts'
import { Effect } from 'effect'
import { defineTool } from '../tool.ts'

export const changeTypeTool = defineTool({
  name: 'change_type',
  description:
    'Changes a type as a whole; what is not given stays. `label` and `description` (not empty) replace them: the description tells agents when to use the type, so sharpen it as its use becomes clearer; the next sessions read it in their instructions. `sensitive` makes a whole type sensitive (a diary, health records): its entries are then shown only to keys with the right `sensitive`; only the owner lifts it, from the command line. `read_in_parent`: its entries filed under an entry of the same type are read as the parts of their parent, in its page. Each change is recorded in the history of the type, before and after.',
  input: ChangeTypeInput,
  right: 'write',
  run: (input) => Effect.map(changeType(input), (type) => ({ type })),
})
