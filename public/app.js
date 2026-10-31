"use strict";

const $ = selector => document.querySelector(selector);

async function api(url, options = {}) {
    const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "The request could not be completed.");
    }

    return data;
}

function showError(element, message) {
    if (element) element.textContent = message || "";
}

function formatDate(value) {
    if (!value) return "Date unavailable";

    const date = parseDate(value);

    if (!date) return "Date unavailable";

    return date.toLocaleString();
}

/* Handles date strings, Unix seconds and Unix milliseconds. */
function parseDate(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    let date;

    if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
        let timestamp = Number(value);

        // Convert Unix seconds to milliseconds.
        if (timestamp > 0 && timestamp < 100000000000) {
            timestamp *= 1000;
        }

        date = new Date(timestamp);
    } else {
        date = new Date(value);
    }

    return Number.isNaN(date.getTime()) ? null : date;
}

/*
 * Inbox timestamp:
 * - Less than 24 hours old: time only.
 * - 24 hours or older: date and time.
 * - Full timestamp is available through the title tooltip.
 */
function formatMessageTimestamp(value) {
    const date = parseDate(value);

    if (!date) return "Date unavailable";

    const now = Date.now();
    const age = now - date.getTime();

    if (age >= 0 && age < 24 * 60 * 60 * 1000) {
        return date.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
        });
    }

    return date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    });
}

function getMessageDate(message) {
    return (
        message.message_date ||
        message.date ||
        message.internalDate ||
        message.received_at ||
        null
    );
}

function initials(name) {
    return String(name || "User")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(part => part[0] || "")
        .join("")
        .toUpperCase();
}

/* ---------------- LOGIN PAGE ---------------- */

async function initLogin() {
    const checkbox = $("#mailboxConsent");
    const button = $("#googleSignIn");
    const error = $("#loginError");

    if (!checkbox || !button) return;

    const params = new URLSearchParams(location.search);

    const errorMessages = {
        consent_required: "Please review and accept the mailbox access disclosure.",
        google_denied: "Google authorization was cancelled or denied.",
        invalid_oauth_state: "The sign-in session expired. Please try again.",
        email_not_verified: "Please use a verified Google email address.",
        authentication_failed: "Google sign-in could not be completed."
    };

    showError(error, errorMessages[params.get("error")] || "");

    checkbox.addEventListener("change", () => {
        button.disabled = !checkbox.checked;
    });

    button.addEventListener("click", async () => {
        if (!checkbox.checked) return;

        button.disabled = true;
        button.textContent = "Connecting...";

        try {
            await api("/auth/consent", {
                method: "POST",
                body: JSON.stringify({
                    mailboxAccess: true
                })
            });

            location.href = "/auth/google";
        } catch (err) {
            showError(error, err.message);
            button.disabled = false;
            button.innerHTML =
                '<span class="google-g">G</span> Continue with Google';
        }
    });
}

/* ---------------- SUCCESS PAGE ---------------- */

async function initSuccess() {
    const name = $("#successName");
    const email = $("#successEmail");

    if (!name || !email) return;

    try {
        const user = await api("/api/user/me");

        name.textContent = user.full_name || "Google user";
        email.textContent = user.email;

        const picture = $("#successPicture");

        if (picture) {
            picture.src = user.profile_picture || "";
            picture.alt = user.full_name || "Google profile picture";
            picture.hidden = !user.profile_picture;
        }
    } catch {
        name.textContent = "Account connection could not be verified.";
    }

    $("#disconnectAccount")?.addEventListener("click", async () => {
        const button = $("#disconnectAccount");
        const error = $("#successError");

        if (!confirm(
            "Disconnect your Google account and revoke this application's access?"
        )) {
            return;
        }

        button.disabled = true;
        button.textContent = "Disconnecting...";

        try {
            await api("/api/user/disconnect", {
                method: "POST",
                body: JSON.stringify({})
            });

            location.href = "/login.html";
        } catch (err) {
            showError(error, err.message);
            button.disabled = false;
            button.textContent = "Disconnect Google account";
        }
    });
}

/* ---------------- ADMIN DASHBOARD ---------------- */

const adminState = {
    users: [],
    notifications: [],
    activeUserId: null,
    messages: [],
    nextPageToken: null,
    selectedMessageIndex: -1,
    lastNotificationIds: new Set(),
    soundEnabled: false,
    polling: null,
    pollingBusy: false,
    userRefresh: null
};

function showAdminSection(section) {
    document.querySelectorAll(".dashboard-section").forEach(element => {
        element.classList.add("hidden");
    });

    document.querySelectorAll(".nav-button").forEach(button => {
        button.classList.toggle(
            "active",
            button.dataset.section === section
        );
    });

    $(`#section-${section}`)?.classList.remove("hidden");

    const headings = {
        overview: "Overview",
        notifications: "Notifications",
        settings: "Settings"
    };

    const heading = $("#pageHeading");

    if (heading) {
        heading.textContent = headings[section] || "Dashboard";
    }
}

async function loadAdminUsers() {
    const users = await api("/api/admin/users");

    adminState.users = users;

    const totalUsers = $("#totalUsers");

    if (totalUsers) {
        totalUsers.textContent = users.length;
    }

    const tbody = $("#usersTable");

    if (!tbody) return;

    tbody.replaceChildren();

    if (!users.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 5;
        cell.className = "empty-state";
        cell.textContent = "No authorized accounts are connected yet.";

        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }

    for (const user of users) {
        const row = document.createElement("tr");

        const userCell = document.createElement("td");
        const userWrap = document.createElement("div");

        userWrap.className = "user-cell";

        const image = document.createElement("img");

        image.className = "user-avatar";
        image.alt = "";
        image.src = user.profile_picture || "";

        image.onerror = () => {
            image.hidden = true;
        };

        const details = document.createElement("div");

        const fullName = document.createElement("strong");
        fullName.textContent = user.full_name || "Google user";

        const smallEmail = document.createElement("small");
        smallEmail.textContent = user.email;

        details.append(fullName, smallEmail);
        userWrap.append(image, details);
        userCell.appendChild(userWrap);

        const emailCell = document.createElement("td");
        emailCell.textContent = user.email;

        const statusCell = document.createElement("td");

        const status = document.createElement("span");
        status.className = "status-pill";
        status.textContent = "Connected";

        statusCell.appendChild(status);

        const countCell = document.createElement("td");

        const count = document.createElement("span");
        count.className = "notification-number";
        count.textContent = user.notification_count;

        countCell.appendChild(count);

        const actionCell = document.createElement("td");

        const openButton = document.createElement("button");

        openButton.className = "button button-primary";
        openButton.textContent = "Read Inbox";

        openButton.addEventListener("click", () => openInbox(user));

        actionCell.appendChild(openButton);

        row.append(
            userCell,
            emailCell,
            statusCell,
            countCell,
            actionCell
        );

        tbody.appendChild(row);
    }
}

async function loadSettings() {
    const settings = await api("/api/admin/settings");

    $("#filterEnabled").checked = settings.filter_enabled;
    $("#filterSenderEmail").value = settings.sender_email || "";
    $("#filterSenderName").value = settings.sender_name || "";
    $("#filterSubject").value = settings.subject || "";
}

async function saveSettings(event) {
    event.preventDefault();

    const status = $("#settingsStatus");

    status.textContent = "Saving...";

    try {
        await api("/api/admin/settings", {
            method: "PUT",
            body: JSON.stringify({
                filter_enabled: $("#filterEnabled").checked,
                sender_email: $("#filterSenderEmail").value,
                sender_name: $("#filterSenderName").value,
                subject: $("#filterSubject").value
            })
        });

        status.textContent = "Settings saved successfully.";

        await loadNotifications();
    } catch (error) {
        status.textContent = error.message;
    }
}

/* ---------------- NOTIFICATIONS ---------------- */

function playNotificationSound() {
    if (!adminState.soundEnabled) return;

    const audio = $("#notificationAudio");

    if (audio) {
        audio.currentTime = 0;
        audio.play().catch(() => playFallbackBeep());
    } else {
        playFallbackBeep();
    }
}

function playFallbackBeep() {
    try {
        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) return;

        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        oscillator.frequency.value = 740;
        gain.gain.value = 0.08;

        oscillator.connect(gain);
        gain.connect(context.destination);

        oscillator.start();
        oscillator.stop(context.currentTime + 0.18);

        oscillator.onended = () => context.close();
    } catch {
        // Sound is optional; notifications remain visible without it.
    }
}

async function loadNotifications() {
    const notifications = await api("/api/admin/notifications");

    const unseen = notifications.filter(item => !item.acknowledged);

    const totalNotifications = $("#totalNotifications");
    const sidebarCount = $("#sidebarNotificationCount");

    if (totalNotifications) {
        totalNotifications.textContent = unseen.length;
    }

    if (sidebarCount) {
        sidebarCount.textContent = unseen.length;
    }

    const list = $("#notificationsList");

    if (!list) return;

    list.replaceChildren();

    if (!notifications.length) {
        const empty = document.createElement("p");

        empty.className = "empty-state";
        empty.textContent = "No notifications yet.";

        list.appendChild(empty);
    }

    for (const item of notifications) {
        const card = document.createElement("div");

        card.className = "notification-item";

        const content = document.createElement("div");

        const title = document.createElement("strong");
        title.textContent = item.subject || "(No subject)";

        const sender = document.createElement("p");

        sender.textContent =
            `${item.sender_name || item.sender_email || "Unknown sender"} ` +
            `(${item.sender_email || "unknown email"})`;

        const account = document.createElement("p");

        account.textContent =
            `Connected account: ${item.account_email}`;

        const date = document.createElement("p");

        date.textContent = formatDate(
            item.message_date || item.created_at
        );

        content.append(title, sender, account, date);

        const button = document.createElement("button");

        button.className = "button button-outline";
        button.textContent = "Open";

        button.addEventListener("click", async () => {
            const user = adminState.users.find(
                entry => String(entry.id) === String(item.user_id)
            );

            if (user) {
                await openInbox(user);

                const index = adminState.messages.findIndex(
                    message =>
                        String(message.gmail_message_id) ===
                        String(item.gmail_message_id)
                );

                if (index >= 0) {
                    await openMessage(index);
                }
            }

            await api(
                `/api/admin/notifications/${item.id}/acknowledge`,
                {
                    method: "POST",
                    body: JSON.stringify({})
                }
            );

            await loadNotifications();
        });

        card.append(content, button);
        list.appendChild(card);
    }

    const currentIds = new Set(
        notifications.map(item => String(item.id))
    );

    const newOnes = notifications.filter(item =>
        !adminState.lastNotificationIds.has(String(item.id))
    );

    if (adminState.lastNotificationIds.size && newOnes.length) {
        playNotificationSound();
    }

    adminState.lastNotificationIds = currentIds;
    adminState.notifications = notifications;
}

async function refreshDashboard() {
    try {
        await loadAdminUsers();
        await loadNotifications();
    } catch (error) {
        console.error(error);
    }
}

/* ---------------- INBOX ---------------- */

async function openInbox(user) {
    adminState.activeUserId = user.id;
    adminState.messages = [];
    adminState.nextPageToken = null;
    adminState.selectedMessageIndex = -1;

    $("#inboxTitle").textContent =
        `${user.full_name || "User"} — Inbox`;

    $("#inboxAccount").textContent = user.email;
    $("#senderSearch").value = "";

    $("#messageList").replaceChildren();

    $("#messageView").textContent = "Select a message to read it.";

    $("#inboxModal").classList.remove("hidden");

    await fetchInboxMessages(false);
}

async function fetchInboxMessages(loadMore) {
    const userId = adminState.activeUserId;

    if (!userId) return;

    const params = new URLSearchParams();

    const search = $("#senderSearch").value.trim();

    if (search) {
        params.set("search", search);
    }

    if (loadMore && adminState.nextPageToken) {
        params.set("pageToken", adminState.nextPageToken);
    }

    const url =
        `/api/admin/inbox/${encodeURIComponent(userId)}?${params}`;

    if (!loadMore && !adminState.messages.length) {
        $("#messageList").textContent = "Loading messages…";
    }

    try {
        const data = await api(url);

        if (!loadMore) {
            adminState.messages = [];
            adminState.selectedMessageIndex = -1;
        }

        adminState.messages.push(...(data.messages || []));

        adminState.nextPageToken = data.nextPageToken || null;

        renderMessageList();

        $("#loadMoreMessages").disabled =
            !adminState.nextPageToken;

        if (!adminState.messages.length) {
            $("#messageList").textContent =
                "No messages match the current filter.";
        }
    } catch (error) {
        const message = document.createElement("p");

        message.className = "empty-state error-state";
        message.textContent = `${error.message} — try refreshing.`;

        if (!adminState.messages.length) {
            $("#messageList").replaceChildren(message);
        } else {
            console.error("Inbox refresh failed:", error);
        }
    }
}

function renderMessageList() {
    const list = $("#messageList");

    list.replaceChildren();

    for (
        let index = 0;
        index < adminState.messages.length;
        index++
    ) {
        const message = adminState.messages[index];

        const button = document.createElement("button");

        button.className = "message-item";

        if (index === adminState.selectedMessageIndex) {
            button.classList.add("active");
        }

        const sender = document.createElement("strong");

        sender.textContent =
            message.sender_name ||
            message.sender_email ||
            "Unknown sender";

        /*
         * NEW: Timestamp beside the sender.
         */
        const timestampValue = getMessageDate(message);

        const timestamp = document.createElement("time");

        timestamp.className = "message-date";
        timestamp.textContent =
            formatMessageTimestamp(timestampValue);

        const parsedDate = parseDate(timestampValue);

        if (parsedDate) {
            timestamp.dateTime = parsedDate.toISOString();
            timestamp.title = parsedDate.toLocaleString();
        }

        const subject = document.createElement("span");

        subject.className = "message-subject";
        subject.textContent = message.subject || "(No subject)";

        const snippet = document.createElement("small");

        snippet.className = "message-snippet";
        snippet.textContent = message.snippet || "";

        button.append(
            sender,
            timestamp,
            subject,
            snippet
        );

        button.addEventListener("click", () => openMessage(index));

        list.appendChild(button);
    }
}

async function openMessage(index) {
    const message = adminState.messages[index];

    if (!message) return;

    adminState.selectedMessageIndex = index;

    renderMessageList();

    const view = $("#messageView");

    view.textContent = "Loading message...";

    try {
        const data = await api(
            `/api/admin/message/${encodeURIComponent(adminState.activeUserId)}/` +
            encodeURIComponent(message.gmail_message_id)
        );

        view.replaceChildren();

        const subject = document.createElement("h3");

        subject.textContent = data.subject || "(No subject)";

        const meta = document.createElement("div");

        meta.className = "message-meta";

        const senderLine = document.createElement("div");

        senderLine.textContent =
            `From: ${data.sender_name || ""} ${data.sender_email || ""}`;

        /*
         * NEW: Timestamp in the full email reading pane.
         * Prefer the full message response, then fall back to
         * the timestamp already available in the inbox list.
         */
        const messageDate =
            data.message_date ||
            data.date ||
            data.internalDate ||
            getMessageDate(message);

        const dateLine = document.createElement("div");

        dateLine.className = "message-date-full";

        const dateLabel = document.createElement("span");

        dateLabel.textContent = "Date: ";

        const dateValue = document.createElement("time");

        dateValue.className = "message-date";

        dateValue.textContent =
            formatMessageTimestamp(messageDate);

        const parsedDate = parseDate(messageDate);

        if (parsedDate) {
            dateValue.dateTime = parsedDate.toISOString();
            dateValue.title = parsedDate.toLocaleString();
        }

        dateLine.append(dateLabel, dateValue);

        meta.append(senderLine, dateLine);

        const body = document.createElement("div");

        body.className = "message-body";

        body.textContent = data.body_text ||
            "This email does not contain a readable plain-text body.";

        const navigation = document.createElement("div");

        navigation.className = "message-navigation";

        const previous = document.createElement("button");

        previous.className = "button button-outline";
        previous.textContent = "Previous";
        previous.disabled = index <= 0;

        previous.addEventListener("click", () => {
            openMessage(index - 1);
        });

        const next = document.createElement("button");

        next.className = "button button-outline";
        next.textContent = "Next";
        next.disabled = index >= adminState.messages.length - 1;

        next.addEventListener("click", () => {
            openMessage(index + 1);
        });

        navigation.append(previous, next);

        view.append(
            subject,
            meta,
            body,
            navigation
        );

        // Start reading the newly opened email from the top.
        view.scrollTop = 0;
    } catch (error) {
        view.textContent = error.message;
    }
}

/* ---------------- ADMIN STARTUP ---------------- */

async function initAdmin() {
    const loginPage = $("#adminLoginPage");
    const dashboard = $("#adminDashboard");

    if (!loginPage || !dashboard) return;

    try {
        const admin = await api("/api/admin/me");

        loginPage.classList.add("hidden");
        dashboard.classList.remove("hidden");

        $("#adminAccountLabel").textContent = admin.email;

        await loadAdminUsers();
        await loadSettings();
        await loadNotifications();

        /*
         * Refresh notification records every 2 seconds.
         * Gmail mailbox discovery itself remains on the
         * server-side quota-safe schedule.
         */
        adminState.polling = setInterval(async () => {
            if (adminState.pollingBusy || document.hidden) return;

            adminState.pollingBusy = true;

            try {
                await loadNotifications();

                const sync = $("#syncStatus");

                if (sync) {
                    sync.textContent =
                        `Updated ${new Date().toLocaleTimeString()}`;
                }
            } catch (error) {
                const sync = $("#syncStatus");

                if (sync) {
                    sync.textContent = "Connection issue · retrying";
                }

                console.error(
                    "Admin notification refresh failed:",
                    error
                );
            } finally {
                adminState.pollingBusy = false;
            }
        }, 2000);

        adminState.userRefresh = setInterval(() => {
            if (!document.hidden) {
                loadAdminUsers().catch(error =>
                    console.error("User list refresh failed:", error)
                );
            }
        }, 30000);

    } catch {
        loginPage.classList.remove("hidden");
        dashboard.classList.add("hidden");
    }

    $("#adminLoginForm")?.addEventListener("submit", async event => {
        event.preventDefault();

        const error = $("#adminLoginError");

        error.textContent = "";

        try {
            const email = $("#adminEmail").value;
            const password = $("#adminPassword").value;

            await api("/api/admin/login", {
                method: "POST",
                body: JSON.stringify({ email, password })
            });

            location.reload();
        } catch (err) {
            showError(error, err.message);
        }
    });

    $("#adminLogout")?.addEventListener("click", async () => {
        try {
            await api("/api/admin/logout", {
                method: "POST",
                body: JSON.stringify({})
            });
        } finally {
            location.reload();
        }
    });

    document.querySelectorAll(".nav-button").forEach(button => {
        button.addEventListener("click", () => {
            showAdminSection(button.dataset.section);
        });
    });

    $("#settingsForm")?.addEventListener("submit", saveSettings);

    $("#refreshUsers")?.addEventListener("click", loadAdminUsers);

    $("#refreshNotifications")?.addEventListener(
        "click",
        loadNotifications
    );

    $("#enableSound")?.addEventListener("click", async () => {
        adminState.soundEnabled = true;

        const audio = $("#notificationAudio");

        if (audio) {
            try {
                audio.volume = 0.9;

                await audio.play();

                audio.pause();
                audio.currentTime = 0;
            } catch {
                playFallbackBeep();
            }
        } else {
            playFallbackBeep();
        }

        $("#enableSound").textContent = "Sound enabled";
    });

    $("#closeInbox")?.addEventListener("click", () => {
        $("#inboxModal").classList.add("hidden");
    });

    $("#inboxModal")?.addEventListener("click", event => {
        if (event.target === $("#inboxModal")) {
            $("#inboxModal").classList.add("hidden");
        }
    });

    $("#searchInbox")?.addEventListener("click", () => {
        fetchInboxMessages(false);
    });

    $("#senderSearch")?.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            fetchInboxMessages(false);
        }
    });

    $("#clearInboxSearch")?.addEventListener("click", () => {
        $("#senderSearch").value = "";
        fetchInboxMessages(false);
    });

    $("#loadMoreMessages")?.addEventListener("click", () => {
        fetchInboxMessages(true);
    });
}

/* ---------------- PAGE INITIALIZATION ---------------- */

document.addEventListener("DOMContentLoaded", () => {
    initLogin();
    initSuccess();
    initAdmin();
});