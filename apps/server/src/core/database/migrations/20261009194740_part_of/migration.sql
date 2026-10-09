-- The place an entry is part of is a dated link `part_of`, with its provenance. The key `parent`
-- of a write says that provenance, as `body` and `summary` say theirs: a field named `parent`
-- would share its key, and is refused, rather than guessed at. The owner renames it first.
DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(format('the type `%s` has a field `parent`', t.name), ' and ' ORDER BY t.name)
    INTO clashes
    FROM "types" t, jsonb_array_elements(t.fields) AS f
    WHERE f ->> 'name' = 'parent';
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION '%', upper(left(clashes, 1)) || substr(clashes, 2)
      || ': it is the key of the provenance of the place an entry is part of. Rename the field first (`change_type` with `field` and `rename`), then start again.';
  END IF;
END $$;
--> statement-breakpoint
-- Which of the links of one entry comes first: the order they were made in.
ALTER TABLE "links" ADD COLUMN "seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "links_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
-- Each parent becomes a link `part_of` without dates, `unstated` as every link made before the
-- writers were asked. A link `part_of` made by hand before stays as it was. The events keep their
-- past changes of `parent_id`.
INSERT INTO "links" ("source_id", "target_id", "relation", "provenance")
  SELECT "id", "parent_id", 'part_of', 'unstated' FROM "entries" WHERE "parent_id" IS NOT NULL
  ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The places an entry is part of form a tree, never a loop: a link `part_of` made by hand before
-- may close one with the parents, and is refused, rather than guessed at.
DO $$
DECLARE
  slugs text[];
  named text;
BEGIN
  WITH RECURSIVE held AS (
    SELECT "source_id", "target_id" FROM "links"
      WHERE "relation" = 'part_of'
        AND ("valid_from" IS NULL OR "valid_from" <= current_date)
        AND ("valid_until" IS NULL OR "valid_until" > current_date)
  ), up (start, id) AS (
    SELECT "source_id", "target_id" FROM held
    UNION
    SELECT up.start, held."target_id" FROM up JOIN held ON held."source_id" = up.id
  )
  SELECT array_agg(e.slug ORDER BY e.slug) INTO slugs
    FROM "entries" e WHERE e.id IN (SELECT start FROM up WHERE id = start);
  IF slugs IS NOT NULL THEN
    named := regexp_replace((SELECT string_agg(format('`%s`', s), ', ') FROM unnest(slugs) AS s),
      ', ([^,]*)$', ' and \1');
    RAISE EXCEPTION '%', 'The links `part_of` make a loop: ' || named
      || CASE WHEN cardinality(slugs) = 1 THEN ' is part of itself' ELSE ' are part of one another' END
      || '. Remove one of them (`link` with `remove`), then start again.';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "entries" DROP CONSTRAINT "entries_parent_id_fkey";--> statement-breakpoint
DROP INDEX "entries_parent_id";--> statement-breakpoint
ALTER TABLE "entries" DROP COLUMN "parent_id";--> statement-breakpoint
CREATE INDEX "links_part_of" ON "links" ("target_id","source_id") WHERE relation = 'part_of';
