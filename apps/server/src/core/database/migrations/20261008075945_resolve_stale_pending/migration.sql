-- References left waiting by a race fixed since, for an entry that exists: linked, as a write
-- would have linked them. Matched by slug, then by alias.
INSERT INTO links (source_id, target_id, relation)
SELECT DISTINCT p.source_id, e.id, 'mentions'
FROM pending_references p
JOIN entries e ON e.slug = p.slug OR e.aliases ? p.slug
WHERE e.id <> p.source_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM pending_references p
WHERE EXISTS (SELECT 1 FROM entries e WHERE e.slug = p.slug OR e.aliases ? p.slug);
