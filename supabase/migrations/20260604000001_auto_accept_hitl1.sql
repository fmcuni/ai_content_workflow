-- Auto-accept the HITL_1 outline gate.
--
-- When an operator files a run (or a topic batch) with auto-accept on, the run
-- should skip the human HITL_1 outline / gap-analysis review and proceed
-- straight to drafting. The HITL_2 draft gate still waits for a human before
-- anything is published to WordPress, so this only removes the FIRST gate.
--
-- runs.auto_accept_hitl1            — per-run flag the production workflow reads
--                                     at the HITL_1 gate.
-- topic_batches.auto_accept_hitl1_default — carried onto every run promoted from
--                                     the batch (the batch itself still has its
--                                     own HITL_T1 topic-review meeting).
--
-- Both default to false so existing rows and all current callers keep the
-- human-gated behaviour. NOT NULL with a default is a safe, instant add.
ALTER TABLE content_tool.runs
  ADD COLUMN IF NOT EXISTS auto_accept_hitl1 boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN content_tool.runs.auto_accept_hitl1 IS
  'When true the run auto-approves its HITL_1 outline/gap-analysis gate and goes '
  'straight to drafting. HITL_2 (draft -> publish) still waits for a human.';

ALTER TABLE content_tool.topic_batches
  ADD COLUMN IF NOT EXISTS auto_accept_hitl1_default boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN content_tool.topic_batches.auto_accept_hitl1_default IS
  'Default carried onto every run promoted from this batch: when true those runs '
  'auto-approve their HITL_1 outline gate.';
