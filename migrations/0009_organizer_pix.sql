-- 0009 — Pix do organizador (D23): chave Pix opcional para gerar o QR / copia e cola de cada parte.
-- Dado pessoal: some na anonimização (D21). Só vale para contas ORGANIZER_COLLECTS.

ALTER TABLE bills ADD COLUMN pix_key text CHECK (length(pix_key) BETWEEN 5 AND 77);
ALTER TABLE bills ADD COLUMN pix_key_type text CHECK (pix_key_type IN ('CPF', 'CNPJ', 'PHONE', 'EMAIL', 'EVP'));
ALTER TABLE bills ADD COLUMN pix_city text CHECK (length(pix_city) BETWEEN 1 AND 40);
ALTER TABLE bills ADD CONSTRAINT bills_pix_pair CHECK ((pix_key IS NULL) = (pix_key_type IS NULL));
ALTER TABLE bills ADD CONSTRAINT bills_pix_only_organizer CHECK (pix_key IS NULL OR collection_model = 'ORGANIZER_COLLECTS');
