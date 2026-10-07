-- The registry of the importer goes; what it holds would be lost, so a registry that holds items
-- is refused rather than dropped.
DO $$
DECLARE
  held bigint;
BEGIN
  SELECT count(*) INTO held FROM "sources";
  IF held > 0 THEN
    RAISE EXCEPTION 'The source registry still holds % items: Grenier no longer reads it. Export what it holds, empty the table `sources`, then start again.', held;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "sources";
