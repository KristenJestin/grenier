-- Full-text search removes accents through this extension (see search/language.ts).
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_apikey" (
	"id" text PRIMARY KEY,
	"configId" text NOT NULL,
	"name" text,
	"start" text,
	"referenceId" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refillInterval" integer,
	"refillAmount" integer,
	"lastRefillAt" timestamp with time zone,
	"enabled" boolean,
	"rateLimitEnabled" boolean,
	"rateLimitTimeWindow" integer,
	"rateLimitMax" integer,
	"requestCount" integer,
	"remaining" integer,
	"lastRequest" timestamp with time zone,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL CONSTRAINT "auth_session_token_key" UNIQUE,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL CONSTRAINT "auth_user_email_key" UNIQUE,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"type" text NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL CONSTRAINT "entries_slug_key" UNIQUE,
	"aliases" jsonb DEFAULT '[]' NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"parent_id" uuid,
	"fields" jsonb DEFAULT '{}' NOT NULL,
	"provenance" jsonb DEFAULT '{}' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"superseded_by" uuid,
	"archived_at" timestamp with time zone,
	"search_language" regconfig DEFAULT 'simple' NOT NULL,
	"media_text" text DEFAULT '' NOT NULL,
	"search" tsvector GENERATED ALWAYS AS (setweight(to_tsvector(search_language, title || ' ' || aliases::text), 'A') ||
      setweight(to_tsvector(search_language, tags::text || ' ' || summary), 'B') ||
      setweight(to_tsvector(search_language, body || ' ' || media_text), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"actor" text NOT NULL,
	"entry_id" uuid,
	"type_name" text,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	CONSTRAINT "events_check" CHECK ((entry_id IS NULL) <> (type_name IS NULL))
);
--> statement-breakpoint
CREATE TABLE "heads_up" (
	"actor" text,
	"entry_id" uuid,
	"field" text,
	"period" text,
	"day" date,
	CONSTRAINT "heads_up_pkey" PRIMARY KEY("actor","entry_id","field","period","day")
);
--> statement-breakpoint
CREATE TABLE "links" (
	"source_id" uuid,
	"target_id" uuid,
	"relation" text,
	"period" text DEFAULT '',
	"field" text DEFAULT '',
	CONSTRAINT "links_pkey" PRIMARY KEY("source_id","target_id","relation","period","field")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration" double precision,
	"source_url" text,
	"alt" text DEFAULT '' NOT NULL,
	"position" integer NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"source" text,
	"identifier" text,
	"entry_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_pkey" PRIMARY KEY("source","identifier")
);
--> statement-breakpoint
CREATE TABLE "type_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"action" text NOT NULL,
	"type_name" text NOT NULL,
	"into_type" text,
	"mapping" jsonb,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "types" (
	"name" text PRIMARY KEY,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"fields" jsonb NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "auth_apikey_key" ON "auth_apikey" ("key");--> statement-breakpoint
CREATE INDEX "auth_session_user" ON "auth_session" ("userId");--> statement-breakpoint
CREATE INDEX "entries_parent_id" ON "entries" ("parent_id");--> statement-breakpoint
CREATE INDEX "entries_search" ON "entries" USING gin ("search");--> statement-breakpoint
CREATE INDEX "events_entry_id" ON "events" ("entry_id");--> statement-breakpoint
CREATE INDEX "events_type_name" ON "events" ("type_name");--> statement-breakpoint
CREATE INDEX "links_target_id" ON "links" ("target_id");--> statement-breakpoint
CREATE INDEX "media_entry_id" ON "media" ("entry_id");--> statement-breakpoint
CREATE INDEX "media_sha256" ON "media" ("sha256");--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_apikey" ADD CONSTRAINT "auth_apikey_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_type_fkey" FOREIGN KEY ("type") REFERENCES "types"("name");--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_name_fkey" FOREIGN KEY ("type_name") REFERENCES "types"("name");--> statement-breakpoint
ALTER TABLE "heads_up" ADD CONSTRAINT "heads_up_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id");--> statement-breakpoint
ALTER TABLE "type_proposals" ADD CONSTRAINT "type_proposals_type_name_fkey" FOREIGN KEY ("type_name") REFERENCES "types"("name");--> statement-breakpoint
ALTER TABLE "type_proposals" ADD CONSTRAINT "type_proposals_into_type_fkey" FOREIGN KEY ("into_type") REFERENCES "types"("name");