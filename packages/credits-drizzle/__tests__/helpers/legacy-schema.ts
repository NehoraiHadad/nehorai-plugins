/**
 * The credit tables exactly as they existed *before* the V2 idempotency work.
 *
 * Integration tests build this first and then apply the published migration,
 * so the migration is verified against the shape real deployments actually
 * have rather than against the current schema definition.
 */
export const LEGACY_BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS credit_balances (
  user_id uuid PRIMARY KEY,
  balance numeric(12,2) NOT NULL DEFAULT '0',
  bonus_credits numeric(12,2) NOT NULL DEFAULT '0',
  reserved numeric(12,2) NOT NULL DEFAULT '0',
  tier text NOT NULL DEFAULT 'free',
  monthly_limit numeric(12,2) NOT NULL DEFAULT '0',
  monthly_used numeric(12,2) NOT NULL DEFAULT '0',
  monthly_reset_at timestamptz NOT NULL,
  subscription_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  operation_type text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_reservations_user_idx
  ON credit_reservations (user_id);
CREATE INDEX IF NOT EXISTS credit_reservations_status_expires_idx
  ON credit_reservations (status, expires_at);

CREATE TABLE IF NOT EXISTS credit_plugin_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  description text NOT NULL,
  payment_ref text,
  previous_balance numeric(12,2) NOT NULL,
  new_balance numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_plugin_transactions_user_created_idx
  ON credit_plugin_transactions (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS credit_plugin_transactions_payment_ref_unique
  ON credit_plugin_transactions (payment_ref) WHERE payment_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  operation_type text NOT NULL,
  provider text NOT NULL,
  credits_used numeric(12,2) NOT NULL,
  success boolean NOT NULL,
  error_message text,
  resource_id text,
  resource_type text,
  request_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_usage_logs_user_created_idx
  ON credit_usage_logs (user_id, created_at);

CREATE TABLE IF NOT EXISTS credit_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entry_type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  balance_after numeric(12,2) NOT NULL,
  source text NOT NULL,
  reference_id text NOT NULL,
  reference_type text NOT NULL,
  description text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_journal_entries_user_created_idx
  ON credit_journal_entries (user_id, created_at);
CREATE INDEX IF NOT EXISTS credit_journal_entries_reference_idx
  ON credit_journal_entries (reference_id, reference_type);
`
