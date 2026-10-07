CREATE TABLE "pending_references" (
	"source_id" uuid,
	"slug" text,
	CONSTRAINT "pending_references_pkey" PRIMARY KEY("source_id","slug")
);
--> statement-breakpoint
CREATE INDEX "pending_references_slug" ON "pending_references" ("slug");--> statement-breakpoint
ALTER TABLE "pending_references" ADD CONSTRAINT "pending_references_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "entries"("id");