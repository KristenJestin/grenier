CREATE TABLE "finding_occurrences" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finding_occurrences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"finding" integer NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"origin" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"trying" text NOT NULL,
	"happened" text NOT NULL,
	"expected" text NOT NULL,
	"steps" text DEFAULT '' NOT NULL,
	"instance" text NOT NULL,
	"version" text NOT NULL,
	"commit" text NOT NULL,
	"key_name" text,
	"call_tool" text,
	"call_arguments" text,
	CONSTRAINT "finding_occurrences_origin" CHECK (origin IN ('agent', 'server'))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"number" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "findings_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"place" text NOT NULL,
	"severity" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "findings_kind" CHECK (kind IN ('bug', 'tool_error', 'unclear_refusal', 'missing_capability', 'wrong_state', 'slow', 'model_friction', 'other')),
	CONSTRAINT "findings_severity" CHECK (severity IN ('blocks', 'hurts', 'cosmetic'))
);
--> statement-breakpoint
CREATE INDEX "finding_occurrences_finding" ON "finding_occurrences" ("finding","at");--> statement-breakpoint
CREATE INDEX "findings_kind_place" ON "findings" ("kind","place");--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_finding_fkey" FOREIGN KEY ("finding") REFERENCES "findings"("number");