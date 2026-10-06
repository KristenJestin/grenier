import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * The tables of Better Auth (`AUTH_TABLES`): the owner, and the API keys of the agents. Columns
 * keep the names Better Auth gives its fields, so its adapter needs no mapping.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE auth_user (
      id text PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL,
      image text,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE auth_session (
      id text PRIMARY KEY,
      "expiresAt" timestamptz NOT NULL,
      token text NOT NULL UNIQUE,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE
    )
  `
  yield* sql`
    CREATE TABLE auth_account (
      id text PRIMARY KEY,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      scope text,
      password text,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE auth_verification (
      id text PRIMARY KEY,
      identifier text NOT NULL,
      value text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE auth_apikey (
      id text PRIMARY KEY,
      "configId" text NOT NULL,
      name text,
      start text,
      "referenceId" text NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
      prefix text,
      key text NOT NULL,
      "refillInterval" integer,
      "refillAmount" integer,
      "lastRefillAt" timestamptz,
      enabled boolean,
      "rateLimitEnabled" boolean,
      "rateLimitTimeWindow" integer,
      "rateLimitMax" integer,
      "requestCount" integer,
      remaining integer,
      "lastRequest" timestamptz,
      "expiresAt" timestamptz,
      "createdAt" timestamptz NOT NULL,
      "updatedAt" timestamptz NOT NULL,
      permissions text,
      metadata text
    )
  `
  yield* sql`CREATE INDEX auth_apikey_key ON auth_apikey (key)`
  yield* sql`CREATE INDEX auth_session_user ON auth_session ("userId")`
})
