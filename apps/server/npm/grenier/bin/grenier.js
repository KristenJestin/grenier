#!/usr/bin/env node
// Runs the executable of this platform, with where its PostgreSQL binaries are: the package of
// the platform carries both, as esbuild carries its own.
'use strict'
const { spawnSync } = require('node:child_process')
const { dirname, join } = require('node:path')

const platform = `${process.platform}-${process.arch}`
/** The folder of an installed package, looked for from `from` (this package by default). */
const found = (name, from) => {
  try {
    return dirname(
      require.resolve(`${name}/package.json`, from === undefined ? {} : { paths: [from] }),
    )
  } catch {
    return undefined
  }
}
const own = found(`@netsirk/grenier-${platform}`)
if (own === undefined) {
  console.error(`Grenier has no build for ${platform} yet: Linux x64 only, for now.`)
  process.exit(1)
}
// A dependency of the package of the platform: looked for from there.
const postgres = found(`@embedded-postgres/${platform}`, own)
const executable = join(own, 'bin', 'grenier')
const env = { ...process.env, GRENIER_EXECUTABLE: executable }
if (postgres !== undefined) env.GRENIER_POSTGRES_BINARIES = join(postgres, 'native')
const ran = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit', env })
process.exit(ran.status ?? 1)
