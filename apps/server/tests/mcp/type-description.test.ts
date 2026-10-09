import { ScratchDatabase, scratchDatabase } from '../../src/core/testing.ts'
import { Effect, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { startServer } from './stdio-client.ts'

const database = ManagedRuntime.make(scratchDatabase)
let url = ''

/** A session starting now, as an agent whose key has `read` and `write`, not `owner`. */
const session = () =>
  startServer({ DATABASE_URL: url, GRENIER_ACTOR: 'agent-test', GRENIER_RIGHTS: 'read,write' })

beforeAll(async () => {
  url = await database.runPromise(
    Effect.gen(function* () {
      return (yield* ScratchDatabase).url
    }),
  )
})

afterAll(() => database.dispose())

describe('change_type { type, description } changes it, types shows it, and the event holds before and after', () => {
  test('a key with write changes the description; the tools and the next session show the new one', async () => {
    const first = await session()
    await first.call('define_type', {
      name: 'gadget',
      label: 'Gadget',
      description: 'A small device.',
      fields: [],
    })
    expect(
      await first.call('change_type', {
        type: 'gadget',
        description: 'Use it for a small device that runs on a battery.',
      }),
    ).toMatchObject({
      result: { type: { description: 'Use it for a small device that runs on a battery.' } },
    })
    expect(await first.call('types', { name: 'gadget' })).toMatchObject({
      result: { type: { description: 'Use it for a small device that runs on a battery.' } },
    })
    expect(await first.call('types', {})).toMatchObject({
      result: {
        types: [
          { name: 'gadget', description: 'Use it for a small device that runs on a battery.' },
        ],
      },
    })
    expect(await first.call('change_type', { type: 'gadget', label: 'Device' })).toMatchObject({
      result: { type: { label: 'Device' } },
    })
    first.close()

    const next = await session()
    expect(next.instructions).toContain(
      '- `gadget`: Use it for a small device that runs on a battery.',
    )
    next.close()
  })
})

describe('an empty description or label is refused with a sentence', () => {
  test('through MCP, with the field it names', async () => {
    const server = await session()
    expect(await server.call('change_type', { type: 'gadget', description: '' })).toEqual({
      error: 'The field `description` must be text that is not empty.',
    })
    expect(await server.call('change_type', { type: 'gadget', label: '' })).toEqual({
      error: 'The field `label` must be text that is not empty.',
    })
    server.close()
  })
})
