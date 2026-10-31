CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    google_id TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL UNIQUE,
    profile_picture TEXT,
    connected BOOLEAN NOT NULL DEFAULT TRUE,
    admin_mailbox_access BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_connections (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE
        REFERENCES users(id) ON DELETE CASCADE,
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    token_expiry TIMESTAMPTZ,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    revoked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consent_records (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    consent_version TEXT NOT NULL,
    profile_consent BOOLEAN NOT NULL DEFAULT FALSE,
    mailbox_access_consent BOOLEAN NOT NULL DEFAULT FALSE,
    disclosed_scopes TEXT[] NOT NULL DEFAULT '{}',
    consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mail_sync_state (
    user_id BIGINT PRIMARY KEY
        REFERENCES users(id) ON DELETE CASCADE,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mail_metadata (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    gmail_message_id TEXT NOT NULL,
    gmail_thread_id TEXT,
    sender_name TEXT,
    sender_email TEXT,
    subject TEXT,
    message_date TIMESTAMPTZ,
    snippet TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_metadata_user_date
ON mail_metadata(user_id, message_date DESC);

CREATE INDEX IF NOT EXISTS idx_mail_metadata_sender
ON mail_metadata(sender_email);

CREATE TABLE IF NOT EXISTS mail_notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    gmail_message_id TEXT NOT NULL,
    sender_name TEXT,
    sender_email TEXT,
    subject TEXT,
    message_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(user_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_created
ON mail_notifications(created_at DESC);

CREATE TABLE IF NOT EXISTS admin_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    filter_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    sender_email TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO admin_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_access_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    gmail_message_id TEXT,
    action TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created
ON admin_access_logs(created_at DESC);