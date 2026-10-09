-- Hippocampe was named Grenier. What it stored under that name is renamed, so the keys already
-- given keep their rights and the entries stay searchable without being indexed again.
--
-- The rights of a key are kept under the statement `grenier`; the statement is `hippocampe`.
-- The secret of a key is not touched: a key given as `grenier_…` still opens the door.
UPDATE "auth_apikey"
  SET "permissions" = regexp_replace("permissions", '^\{"grenier":', '{"hippocampe":')
  WHERE "permissions" LIKE '{"grenier":%';
--> statement-breakpoint
-- The text search configurations `grenier_<language>` become `hippocampe_<language>`. The entries
-- point at a configuration by its identity, not by its name: they follow the rename. One that
-- already has the new name (a configuration made by hand) is left as it is.
DO $$
DECLARE
  old record;
BEGIN
  FOR old IN
    SELECT c.cfgname FROM pg_ts_config c
      WHERE c.cfgname LIKE 'grenier\_%' AND c.cfgnamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_ts_config n
            WHERE n.cfgnamespace = c.cfgnamespace
              AND n.cfgname = 'hippocampe_' || substr(c.cfgname, 9))
  LOOP
    EXECUTE format('ALTER TEXT SEARCH CONFIGURATION public.%I RENAME TO %I',
      old.cfgname, 'hippocampe_' || substr(old.cfgname, 9));
  END LOOP;
END $$;
