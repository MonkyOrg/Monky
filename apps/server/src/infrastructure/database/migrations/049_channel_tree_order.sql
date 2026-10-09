-- Categories and channels outside every category now share one root order, so
-- a loose channel can sit between categories. Before this, the two lists were
-- numbered separately and loose channels were always drawn first; keep that
-- exact layout by numbering loose channels before the categories.
CREATE TEMP TABLE channel_tree_root AS
SELECT kind, id, ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY grp, position, created_at, id) - 1 AS next_position
FROM (
  SELECT 'channel' AS kind, id, server_id, 0 AS grp, position, created_at FROM channels
  WHERE forum_parent_id IS NULL
    AND (category_id IS NULL OR category_id NOT IN (SELECT id FROM channel_categories))
  UNION ALL
  SELECT 'category' AS kind, id, server_id, 1 AS grp, position, created_at FROM channel_categories
);

UPDATE channels
SET position = (SELECT next_position FROM channel_tree_root r WHERE r.kind = 'channel' AND r.id = channels.id)
WHERE id IN (SELECT id FROM channel_tree_root WHERE kind = 'channel');

UPDATE channel_categories
SET position = (SELECT next_position FROM channel_tree_root r WHERE r.kind = 'category' AND r.id = channel_categories.id)
WHERE id IN (SELECT id FROM channel_tree_root WHERE kind = 'category');

DROP TABLE channel_tree_root;
