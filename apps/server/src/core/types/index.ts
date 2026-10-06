/** Types as data: what a type is, and how it is defined, read and extended. */
export { FIELD_KINDS, FieldDefinition, TypeDefinition } from './definition.ts'
export { addField, defineType, getType, listTypes } from './operations.ts'
export {
  ChangeFieldInput,
  changeField,
  confirmProposal,
  listProposals,
  Proposal,
  proposeTypeDeletion,
  proposeTypeMerge,
} from './changes.ts'
