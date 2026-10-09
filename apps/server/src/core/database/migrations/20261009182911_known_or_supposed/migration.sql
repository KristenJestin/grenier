-- A field named `body` or `summary` would share its key in `provenance` with the body or the
-- summary of its entry: refused, rather than guessed at. The owner renames it first.
DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(format('the type `%s` has a field `%s`', t.name, f ->> 'name'), ' and '
      ORDER BY t.name, f ->> 'name')
    INTO clashes
    FROM "types" t, jsonb_array_elements(t.fields) AS f
    WHERE f ->> 'name' IN ('body', 'summary');
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION '%', upper(left(clashes, 1)) || substr(clashes, 2)
      || ': they are the keys of the provenance of the summary and the body of an entry. Rename these fields first (`change_type` with `field` and `rename`), then start again.';
  END IF;
END $$;
--> statement-breakpoint
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
