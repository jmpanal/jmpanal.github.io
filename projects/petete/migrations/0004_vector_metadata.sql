-- Existing embeddings need the source/tax/date_epoch metadata required by filtered search.
-- Preserve verified source text and generated summaries; only requeue vector publication.
UPDATE ruling_chunks SET embedding_status='pending',attempts=0,retry_at=NULL,error=NULL WHERE embedding_status='indexed';
UPDATE rulings SET embedding_status='pending' WHERE id IN (SELECT ruling_id FROM ruling_chunks WHERE embedding_status='pending');
