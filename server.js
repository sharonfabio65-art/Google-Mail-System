require("dotenv").config();

const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { Pool } = require("pg");
const { google } = require("googleapis");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PgSession = connectPgSimple(session);

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const REQUIRED_ENV = [
    "DATABASE_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "SESSION_SECRET",
    "TOKEN_ENCRYPTION_KEY",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD_HASH"
];

for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
}

if (!/^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.");
}

const ENCRYPTION_KEY = Buffer.from(
    process.env.TOKEN_ENCRYPTION_KEY,
    "hex"
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined
});

const SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly"
];

const CONSENT_VERSION = "2026-10-31-v1";

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

if (IS_PRODUCTION) {
    app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "https:", "data:"],
            connectSrc: ["'self'"],
            mediaSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"]
        }
    }
}));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
    name: "google_mail_session",
    store: new PgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: IS_PRODUCTION,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 8
    }
}));

app.use(express.static(path.join(__dirname, "public"), {
    index: false
}));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false
});

function encryptToken(value) {
    if (!value) return null;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        ENCRYPTION_KEY,
        iv
    );

    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final()
    ]);

    const tag = cipher.getAuthTag();

    return [
        iv.toString("hex"),
        tag.toString("hex"),
        encrypted.toString("hex")
    ].join(":");
}

function decryptToken(value) {
    if (!value) return null;

    const parts = value.split(":");

    if (parts.length !== 3) {
        throw new Error("Invalid encrypted token format.");
    }

    const [ivHex, tagHex, encryptedHex] = parts;

    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        ENCRYPTION_KEY,
        Buffer.from(ivHex, "hex")
    );

    decipher.setAuthTag(Buffer.from(tagHex, "hex"));

    return Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, "hex")),
        decipher.final()
    ]).toString("utf8");
}

function requireUser(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            error: "Please sign in first."
        });
    }

    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.isAdmin) {
        return res.status(401).json({
            error: "Administrator login required."
        });
    }

    next();
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function parseEmailHeader(value = "") {
    const match = String(value).match(/^(.*?)\s*<([^<>]+)>$/);

    if (match) {
        return {
            name: match[1].replace(/^["']|["']$/g, "").trim(),
            email: normalizeEmail(match[2])
        };
    }

    const emailMatch = String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

    return {
        name: "",
        email: emailMatch ? normalizeEmail(emailMatch[0]) : ""
    };
}

function headerValue(headers, name) {
    const header = (headers || []).find(
        item => item.name.toLowerCase() === name.toLowerCase()
    );

    return header ? header.value : "";
}

function getFilterMatch(message, settings) {
    if (!settings.filter_enabled) return true;

    const emailFilter = normalizeEmail(settings.sender_email);
    const nameFilter = String(settings.sender_name || "").trim().toLowerCase();
    const subjectFilter = String(settings.subject || "").trim().toLowerCase();

    if (!emailFilter && !nameFilter && !subjectFilter) {
        return true;
    }

    const emailMatches = !emailFilter ||
        normalizeEmail(message.sender_email) === emailFilter;

    const nameMatches = !nameFilter ||
        String(message.sender_name || "").toLowerCase().includes(nameFilter);

    const subjectMatches = !subjectFilter ||
        String(message.subject || "").toLowerCase().includes(subjectFilter);

    return emailMatches && nameMatches && subjectMatches;
}

async function getUserGoogleClient(userId) {
    const result = await pool.query(
        `SELECT gc.*, u.connected, u.admin_mailbox_access
         FROM google_connections gc
         JOIN users u ON u.id = gc.user_id
         WHERE gc.user_id = $1`,
        [userId]
    );

    if (!result.rowCount) {
        throw new Error("Google connection not found.");
    }

    const connection = result.rows[0];

    if (!connection.connected ||
        !connection.admin_mailbox_access ||
        connection.revoked_at) {
        throw new Error("Mailbox access is not authorized.");
    }

    const client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );

    client.setCredentials({
        access_token: decryptToken(connection.access_token_encrypted),
        refresh_token: decryptToken(connection.refresh_token_encrypted),
        expiry_date: connection.token_expiry
            ? new Date(connection.token_expiry).getTime()
            : undefined
    });

    client.on("tokens", async tokens => {
        try {
            const current = await pool.query(
                `SELECT access_token_encrypted, refresh_token_encrypted
                 FROM google_connections
                 WHERE user_id = $1`,
                [userId]
            );

            if (!current.rowCount) return;

            const old = current.rows[0];

            await pool.query(
                `UPDATE google_connections
                 SET access_token_encrypted = $1,
                     refresh_token_encrypted = $2,
                     token_expiry = $3,
                     updated_at = NOW()
                 WHERE user_id = $4`,
                [
                    tokens.access_token
                        ? encryptToken(tokens.access_token)
                        : old.access_token_encrypted,
                    tokens.refresh_token
                        ? encryptToken(tokens.refresh_token)
                        : old.refresh_token_encrypted,
                    tokens.expiry_date
                        ? new Date(tokens.expiry_date)
                        : null,
                    userId
                ]
            );
        } catch (error) {
            console.error("Token refresh persistence failed:", error.message);
        }
    });

    return client;
}

async function getAdminSettings() {
    const result = await pool.query(
        `SELECT filter_enabled, sender_email, sender_name, subject
         FROM admin_settings
         WHERE id = 1`
    );

    return result.rows[0] || {
        filter_enabled: false,
        sender_email: "",
        sender_name: "",
        subject: ""
    };
}

async function getMessageMetadata(gmail, userId, messageId) {
    const result = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"]
    });

    const headers = result.data.payload?.headers || [];
    const sender = parseEmailHeader(headerValue(headers, "From"));

    const message = {
        gmail_message_id: result.data.id,
        gmail_thread_id: result.data.threadId || null,
        sender_name: sender.name,
        sender_email: sender.email,
        subject: headerValue(headers, "Subject"),
        message_date: headerValue(headers, "Date")
            ? new Date(headerValue(headers, "Date"))
            : null,
        snippet: result.data.snippet || ""
    };

    await pool.query(
        `INSERT INTO mail_metadata
         (user_id, gmail_message_id, gmail_thread_id,
          sender_name, sender_email, subject, message_date, snippet)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, gmail_message_id)
         DO UPDATE SET
            sender_name = EXCLUDED.sender_name,
            sender_email = EXCLUDED.sender_email,
            subject = EXCLUDED.subject,
            message_date = EXCLUDED.message_date,
            snippet = EXCLUDED.snippet`,
        [
            userId,
            message.gmail_message_id,
            message.gmail_thread_id,
            message.sender_name,
            message.sender_email,
            message.subject,
            message.message_date,
            message.snippet
        ]
    );

    return message;
}

/* ---------------- USER GOOGLE SIGN-IN ---------------- */

app.get("/login.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/success.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "success.html"));
});

/*
  This endpoint records the user's separate, explicit permission
  for an administrator to view Inbox messages.
*/
app.post("/auth/consent", authLimiter, async (req, res) => {
    const accepted = req.body && req.body.mailboxAccess === true;

    if (!accepted) {
        return res.status(400).json({
            error: "Mailbox access permission is required to continue."
        });
    }

    req.session.mailboxAccessConsent = true;

    res.json({ success: true });
});

app.get("/auth/google", authLimiter, (req, res) => {
    if (!req.session.mailboxAccessConsent) {
        return res.redirect("/login.html?error=consent_required");
    }

    const state = crypto.randomBytes(32).toString("hex");
    req.session.oauthState = state;

    const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent select_account",
        scope: SCOPES,
        state,
        include_granted_scopes: true
    });

    res.redirect(url);
});

app.get("/auth/google/callback", authLimiter, async (req, res) => {
    try {
        const { code, state, error } = req.query;

        if (error) {
            return res.redirect("/login.html?error=google_denied");
        }

        if (!code ||
            !state ||
            !req.session.oauthState ||
            state !== req.session.oauthState) {
            return res.redirect("/login.html?error=invalid_oauth_state");
        }

        delete req.session.oauthState;

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({
            auth: oauth2Client,
            version: "v2"
        });

        const profileResponse = await oauth2.userinfo.get();
        const profile = profileResponse.data;

        if (!profile.id || !profile.email) {
            throw new Error("Google did not return a valid account profile.");
        }

        const email = normalizeEmail(profile.email);

        if (!profile.verified_email) {
            return res.redirect("/login.html?error=email_not_verified");
        }

        const userResult = await pool.query(
            `INSERT INTO users
             (google_id, full_name, email, profile_picture,
              connected, admin_mailbox_access)
             VALUES ($1,$2,$3,$4,TRUE,TRUE)
             ON CONFLICT (google_id)
             DO UPDATE SET
                full_name = EXCLUDED.full_name,
                email = EXCLUDED.email,
                profile_picture = EXCLUDED.profile_picture,
                connected = TRUE,
                admin_mailbox_access = TRUE,
                updated_at = NOW()
             RETURNING id`,
            [
                profile.id,
                profile.name || "",
                email,
                profile.picture || null
            ]
        );

        const userId = userResult.rows[0].id;

        const oldConnection = await pool.query(
            `SELECT refresh_token_encrypted
             FROM google_connections
             WHERE user_id = $1`,
            [userId]
        );

        const refreshToken = tokens.refresh_token
            ? encryptToken(tokens.refresh_token)
            : oldConnection.rows[0]?.refresh_token_encrypted || null;

        if (!refreshToken) {
            throw new Error(
                "Google did not provide a refresh token. Please reconnect and approve offline access."
            );
        }

        await pool.query(
            `INSERT INTO google_connections
             (user_id, access_token_encrypted, refresh_token_encrypted,
              token_expiry, scopes, revoked_at)
             VALUES ($1,$2,$3,$4,$5,NULL)
             ON CONFLICT (user_id)
             DO UPDATE SET
                access_token_encrypted = EXCLUDED.access_token_encrypted,
                refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                token_expiry = EXCLUDED.token_expiry,
                scopes = EXCLUDED.scopes,
                revoked_at = NULL,
                updated_at = NOW()`,
            [
                userId,
                tokens.access_token ? encryptToken(tokens.access_token) : null,
                refreshToken,
                tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                SCOPES
            ]
        );

        await pool.query(
            `INSERT INTO consent_records
             (user_id, consent_version, profile_consent,
              mailbox_access_consent, disclosed_scopes)
             VALUES ($1,$2,TRUE,TRUE,$3)`,
            [userId, CONSENT_VERSION, SCOPES]
        );

        await pool.query(
            `INSERT INTO mail_sync_state (user_id, last_checked_at)
             VALUES ($1, NOW())
             ON CONFLICT (user_id)
             DO NOTHING`,
            [userId]
        );

        await new Promise((resolve, reject) => {
            req.session.regenerate(err => err ? reject(err) : resolve());
        });

        req.session.userId = userId;
        req.session.mailboxAccessConsent = true;

        res.redirect("/success.html");
    } catch (error) {
        console.error("Google OAuth callback error:", error.message);
        res.redirect("/login.html?error=authentication_failed");
    }
});

app.get("/api/user/me", requireUser, async (req, res) => {
    const result = await pool.query(
        `SELECT id, full_name, email, profile_picture,
                connected, admin_mailbox_access
         FROM users
         WHERE id = $1`,
        [req.session.userId]
    );

    if (!result.rowCount) {
        return res.status(404).json({ error: "Account not found." });
    }

    res.json(result.rows[0]);
});

app.post("/api/user/disconnect", requireUser, async (req, res) => {
    const userId = req.session.userId;

    try {
        const result = await pool.query(
            `SELECT access_token_encrypted, refresh_token_encrypted
             FROM google_connections
             WHERE user_id = $1`,
            [userId]
        );

        if (result.rowCount) {
            const connection = result.rows[0];
            const token = decryptToken(
                connection.refresh_token_encrypted
            ) || decryptToken(connection.access_token_encrypted);

            if (token) {
                try {
                    await oauth2Client.revokeToken(token);
                } catch (error) {
                    console.warn("Google token revocation response:", error.message);
                }
            }
        }

        await pool.query(
            `UPDATE users
             SET connected = FALSE,
                 admin_mailbox_access = FALSE,
                 updated_at = NOW()
             WHERE id = $1`,
            [userId]
        );

        await pool.query(
            `UPDATE google_connections
             SET access_token_encrypted = NULL,
                 refresh_token_encrypted = NULL,
                 revoked_at = NOW(),
                 updated_at = NOW()
             WHERE user_id = $1`,
            [userId]
        );

        await pool.query(
            `DELETE FROM mail_sync_state WHERE user_id = $1`,
            [userId]
        );

        req.session.destroy(() => {});

        res.json({ success: true });
    } catch (error) {
        console.error("Disconnect error:", error.message);
        res.status(500).json({ error: "Could not disconnect account." });
    }
});

/* ---------------- ADMIN AUTHENTICATION ---------------- */

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/api/admin/login", adminLimiter, async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || "");

        if (!email || !password ||
            email !== normalizeEmail(process.env.ADMIN_EMAIL)) {
            return res.status(401).json({
                error: "Invalid administrator credentials."
            });
        }

        const valid = await bcrypt.compare(
            password,
            process.env.ADMIN_PASSWORD_HASH
        );

        if (!valid) {
            return res.status(401).json({
                error: "Invalid administrator credentials."
            });
        }

        await new Promise((resolve, reject) => {
            req.session.regenerate(err => err ? reject(err) : resolve());
        });

        req.session.isAdmin = true;
        req.session.adminEmail = email;

        res.json({ success: true });
    } catch (error) {
        console.error("Admin login error:", error.message);
        res.status(500).json({ error: "Administrator login failed." });
    }
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
    res.json({
        authenticated: true,
        email: req.session.adminEmail
    });
});

/* ---------------- ADMIN SETTINGS ---------------- */

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
    const settings = await getAdminSettings();
    res.json(settings);
});

app.put("/api/admin/settings", requireAdmin, async (req, res) => {
    try {
        const senderEmail = normalizeEmail(req.body.sender_email);
        const senderName = String(req.body.sender_name || "").trim();
        const subject = String(req.body.subject || "").trim();
        const filterEnabled = req.body.filter_enabled === true;

        if (senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
            return res.status(400).json({
                error: "Enter a valid sender email address."
            });
        }

        if (senderName.length > 200 || subject.length > 300) {
            return res.status(400).json({
                error: "One of the filter fields is too long."
            });
        }

        await pool.query(
            `UPDATE admin_settings
             SET filter_enabled = $1,
                 sender_email = $2,
                 sender_name = $3,
                 subject = $4,
                 updated_at = NOW()
             WHERE id = 1`,
            [filterEnabled, senderEmail, senderName, subject]
        );

        res.json({
            success: true,
            settings: await getAdminSettings()
        });
    } catch (error) {
        console.error("Settings update error:", error.message);
        res.status(500).json({ error: "Could not save settings." });
    }
});

/* ---------------- ADMIN USER LIST ---------------- */

app.get("/api/admin/users", requireAdmin, async (req, res) => {
    const result = await pool.query(
        `SELECT
            u.id,
            u.full_name,
            u.email,
            u.profile_picture,
            u.connected,
            u.admin_mailbox_access,
            u.created_at,
            (
                SELECT COUNT(*)::int
                FROM mail_notifications n
                WHERE n.user_id = u.id
                  AND n.acknowledged = FALSE
            ) AS notification_count
         FROM users u
         WHERE u.connected = TRUE
           AND u.admin_mailbox_access = TRUE
         ORDER BY u.created_at DESC`
    );

    res.json(result.rows);
});

/* ---------------- ADMIN INBOX ---------------- */

app.get("/api/admin/inbox/:userId", requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.userId);
        const pageToken = String(req.query.pageToken || "");
        const search = String(req.query.search || "").trim();

        if (!Number.isSafeInteger(userId) || userId <= 0) {
            return res.status(400).json({ error: "Invalid user ID." });
        }

        const userResult = await pool.query(
            `SELECT id FROM users
             WHERE id = $1
               AND connected = TRUE
               AND admin_mailbox_access = TRUE`,
            [userId]
        );

        if (!userResult.rowCount) {
            return res.status(404).json({
                error: "Authorized mailbox not found."
            });
        }

        const auth = await getUserGoogleClient(userId);
        const gmail = google.gmail({ version: "v1", auth });
        const settings = await getAdminSettings();

        let query = "in:inbox";

        if (search) {
            // Gmail search syntax is used for the administrator's
            // ad-hoc sender search. It does not expand OAuth permissions.
            const safeSearch = search.replace(/["\\]/g, "");
            query += ` from:${safeSearch}`;
        }

        const response = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: 30,
            pageToken: pageToken || undefined
        });

        const messageIds = (response.data.messages || []).map(item => item.id);
        const messages = [];

        for (const messageId of messageIds) {
            const metadata = await getMessageMetadata(
                gmail,
                userId,
                messageId
            );

            if (getFilterMatch(metadata, settings)) {
                messages.push(metadata);
            }
        }

        await pool.query(
            `INSERT INTO admin_access_logs
             (user_id, action, admin_email)
             VALUES ($1, 'view_inbox', $2)`,
            [userId, req.session.adminEmail]
        );

        res.json({
            messages,
            nextPageToken: response.data.nextPageToken || null
        });
    } catch (error) {
        console.error("Inbox error:", error.message);
        res.status(500).json({
            error: "Could not retrieve this Inbox."
        });
    }
});

/* ---------------- OPEN ONE EMAIL ---------------- */

function decodeBase64Url(value) {
    if (!value) return "";

    return Buffer.from(
        value.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
    ).toString("utf8");
}

function extractMessageBody(payload) {
    if (!payload) return "";

    if (payload.mimeType === "text/plain" && payload.body?.data) {
        return decodeBase64Url(payload.body.data);
    }

    if (payload.parts) {
        for (const part of payload.parts) {
            const found = extractMessageBody(part);
            if (found) return found;
        }
    }

    return "";
}

app.get(
    "/api/admin/message/:userId/:messageId",
    requireAdmin,
    async (req, res) => {
        try {
            const userId = Number(req.params.userId);
            const messageId = String(req.params.messageId);

            if (!Number.isSafeInteger(userId) ||
                userId <= 0 ||
                !/^[a-zA-Z0-9_-]+$/.test(messageId)) {
                return res.status(400).json({
                    error: "Invalid message request."
                });
            }

            const auth = await getUserGoogleClient(userId);
            const gmail = google.gmail({ version: "v1", auth });

            const response = await gmail.users.messages.get({
                userId: "me",
                id: messageId,
                format: "full"
            });

            const headers = response.data.payload?.headers || [];
            const sender = parseEmailHeader(
                headerValue(headers, "From")
            );

            const body = extractMessageBody(response.data.payload);

            await pool.query(
                `INSERT INTO admin_access_logs
                 (user_id, gmail_message_id, action, admin_email)
                 VALUES ($1,$2,'open_message',$3)`,
                [userId, messageId, req.session.adminEmail]
            );

            res.json({
                id: response.data.id,
                sender_name: sender.name,
                sender_email: sender.email,
                subject: headerValue(headers, "Subject"),
                date: headerValue(headers, "Date"),
                body_text: body
            });
        } catch (error) {
            console.error("Message retrieval error:", error.message);
            res.status(500).json({
                error: "Could not open this message."
            });
        }
    }
);

/* ---------------- NOTIFICATIONS ---------------- */

app.get("/api/admin/notifications", requireAdmin, async (req, res) => {
    const result = await pool.query(
        `SELECT
            n.id,
            n.user_id,
            u.full_name,
            u.email AS account_email,
            n.gmail_message_id,
            n.sender_name,
            n.sender_email,
            n.subject,
            n.message_date,
            n.created_at,
            n.acknowledged
         FROM mail_notifications n
         JOIN users u ON u.id = n.user_id
         WHERE n.created_at > NOW() - INTERVAL '7 days'
         ORDER BY n.created_at DESC
         LIMIT 100`
    );

    res.json(result.rows);
});

app.post(
    "/api/admin/notifications/:id/acknowledge",
    requireAdmin,
    async (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ error: "Invalid notification." });
        }

        await pool.query(
            `UPDATE mail_notifications
             SET acknowledged = TRUE
             WHERE id = $1`,
            [id]
        );

        res.json({ success: true });
    }
);

/* ---------------- ONE-MINUTE MAIL POLLING ---------------- */

let pollInProgress = false;

async function pollMailboxes() {
    if (pollInProgress) return;
    pollInProgress = true;

    try {
        const settings = await getAdminSettings();

        const users = await pool.query(
            `SELECT u.id
             FROM users u
             JOIN google_connections gc ON gc.user_id = u.id
             WHERE u.connected = TRUE
               AND u.admin_mailbox_access = TRUE
               AND gc.revoked_at IS NULL`
        );

        for (const user of users.rows) {
            const userId = user.id;

            try {
                const syncResult = await pool.query(
                    `SELECT last_checked_at
                     FROM mail_sync_state
                     WHERE user_id = $1`,
                    [userId]
                );

                if (!syncResult.rowCount) continue;

                const lastChecked = new Date(
                    syncResult.rows[0].last_checked_at
                );

                const afterSeconds = Math.floor(lastChecked.getTime() / 1000);

                const auth = await getUserGoogleClient(userId);
                const gmail = google.gmail({ version: "v1", auth });

                let pageToken;
                let scanned = 0;

                do {
                    const response = await gmail.users.messages.list({
                        userId: "me",
                        q: `in:inbox after:${afterSeconds}`,
                        maxResults: 100,
                        pageToken
                    });

                    const items = response.data.messages || [];

                    for (const item of items) {
                        scanned++;

                        if (scanned > 300) break;

                        const metadata = await getMessageMetadata(
                            gmail,
                            userId,
                            item.id
                        );

                        if (!getFilterMatch(metadata, settings)) {
                            continue;
                        }

                        await pool.query(
                            `INSERT INTO mail_notifications
                             (user_id, gmail_message_id, sender_name,
                              sender_email, subject, message_date)
                             VALUES ($1,$2,$3,$4,$5,$6)
                             ON CONFLICT (user_id, gmail_message_id)
                             DO NOTHING`,
                            [
                                userId,
                                metadata.gmail_message_id,
                                metadata.sender_name,
                                metadata.sender_email,
                                metadata.subject,
                                metadata.message_date
                            ]
                        );
                    }

                    pageToken = response.data.nextPageToken;

                } while (pageToken && scanned <= 300);

                await pool.query(
                    `UPDATE mail_sync_state
                     SET last_checked_at = NOW()
                     WHERE user_id = $1`,
                    [userId]
                );

            } catch (error) {
                console.error(
                    `Mailbox polling failed for user ${userId}:`,
                    error.message
                );
            }
        }
    } catch (error) {
        console.error("Polling service error:", error.message);
    } finally {
        pollInProgress = false;
    }
}

setInterval(pollMailboxes, 60 * 1000);

/* ---------------- HEALTH CHECK AND STARTUP ---------------- */

app.get("/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "ok" });
    } catch {
        res.status(503).json({ status: "database_unavailable" });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: "Page or endpoint not found." });
});

app.use((error, req, res, next) => {
    console.error("Unhandled application error:", error.message);

    if (res.headersSent) return next(error);

    res.status(500).json({
        error: "An unexpected server error occurred."
    });
});

async function startServer() {
    await pool.query("SELECT 1");

    app.listen(PORT, () => {
        console.log(`Google Mail System running on port ${PORT}`);
    });

    // Initial polling starts after the service is ready.
    pollMailboxes();
}

startServer().catch(error => {
    console.error("Startup failed:", error);
    process.exit(1);
});