-- Full question/answer log: the model's answer (first 8,000 chars) and which turn of the
-- conversation the question was (1 = opening question), so follow-ups are visible.
ALTER TABLE requests ADD COLUMN response TEXT;
ALTER TABLE requests ADD COLUMN turn INTEGER;
