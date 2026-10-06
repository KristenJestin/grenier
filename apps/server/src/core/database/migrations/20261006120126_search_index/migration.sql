DROP INDEX "entries_search";--> statement-breakpoint
CREATE INDEX "entries_search" ON "entries" USING gin ((search
  || setweight(jsonb_to_tsvector(search_language, fields, '["string", "numeric"]'), 'C')
  || setweight(jsonb_to_tsvector(search_language,
    jsonb_path_query_array(sources, '$[*].url')
      || jsonb_path_query_array(sources, '$[*].identifier')
      || jsonb_path_query_array(sources, '$[*].label'), '["string"]'), 'C')));--> statement-breakpoint
CREATE INDEX "entries_sources" ON "entries" USING gin ("sources" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "entries_type" ON "entries" ("type");