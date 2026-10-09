-- Every value, link, body and summary says whether it is known or supposed. What was written
-- before Grenier asked is `unstated`: kept, and listed apart from the suppositions, so the owner
-- is not asked to review the past at once. A provenance already stored stays as it is. The
-- events keep their past changes, `verified` included.
ALTER TABLE "links" ADD COLUMN "provenance" text;--> statement-breakpoint
-- A `mentions` link has no provenance of its own: it takes its body's.
UPDATE "links" SET "provenance" = 'unstated' WHERE "relation" <> 'mentions';--> statement-breakpoint
UPDATE "entries" SET "provenance" =
  (SELECT coalesce(jsonb_object_agg(k, 'unstated'), '{}'::jsonb) FROM jsonb_object_keys("fields") AS k)
  || CASE WHEN "body" <> '' THEN '{"body": "unstated"}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN "summary" <> '' THEN '{"summary": "unstated"}'::jsonb ELSE '{}'::jsonb END
  || "provenance";--> statement-breakpoint
ALTER TABLE "entries" DROP COLUMN "verified";--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_provenance" CHECK ((relation = 'mentions') = (provenance IS NULL)
        AND (provenance IS NULL OR provenance IN ('extracted', 'inferred', 'unstated')));
