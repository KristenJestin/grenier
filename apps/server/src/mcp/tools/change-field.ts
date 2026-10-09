import { ChangeFieldInput, changeField } from '../../core/types/index.ts'
import { defineTool } from '../tool.ts'

export const changeFieldTool = defineTool({
  name: 'change_field',
  description:
    'Changes a field of a type: make it required, change its kind, rename it, change its values, change the `types` an entry field accepts (`null` accepts any; stored values that no longer fit are kept and listed in `mismatched`), make it `many` (each stored value becomes a list of one) or single again (refused while an entry holds several values), make it sensitive (only the owner makes it no longer sensitive). Refused while entries would break, naming them; a `default` or a `mapping` repairs them. Try it with `dry_run` first.',
  input: ChangeFieldInput,
  right: 'write',
  hints: { destructive: true, idempotent: false },
  run: (input) => changeField(input),
})
