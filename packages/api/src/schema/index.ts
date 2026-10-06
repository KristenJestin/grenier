/**
 * The schemas shared by Grenier's programs, and the conventions every schema follows. Each
 * convention is proven by a test under `packages/api/tests/`.
 */
export { formatSchemaError, toFormSchema } from './messages.ts'
export { toToolInputSchema, type ToolInputSchema } from './tool-input.ts'
