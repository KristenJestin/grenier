import { ChangeTypeInput, changeType } from '../../core/types/index.ts'
import { Effect } from 'effect'
import { defineTool } from '../tool.ts'

export const changeTypeTool = defineTool({
  name: 'change_type',
  description:
    'Makes a whole type sensitive (a diary, health records): its entries are then shown only to keys with the right `sensitive`. Only such a key may lift it.',
  input: ChangeTypeInput,
  right: 'write',
  run: (input) => Effect.map(changeType(input), (type) => ({ type })),
})
