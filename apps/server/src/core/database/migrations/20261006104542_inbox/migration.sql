CREATE TABLE "inbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"kind" text NOT NULL,
	"name" text,
	"content" text,
	"sha256" text,
	"size" integer,
	"origin" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"taken_by" text,
	"taken_at" timestamp with time zone,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "inbox_kind" CHECK (kind IN ('text', 'url', 'file')),
	CONSTRAINT "inbox_status" CHECK (status IN ('pending', 'taken', 'processed', 'dismissed'))
);
--> statement-breakpoint
CREATE INDEX "inbox_status" ON "inbox" ("status","received_at");