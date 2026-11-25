# Jira Feedback Mailer

A Google Apps Script that sends an email with a **pre-filled Google Form link** when a **Jira Cloud** ticket moves into a status you choose. For example, ask the reporter for feedback when a ticket reaches *Done*.

- **No Jira admin access needed.** It reads Jira with an ordinary account and an API token. You don't need webhooks, Automation rules or Marketplace apps.
- **No server.** It runs on Google's infrastructure every few minutes, for free.
- **Emails each ticket at most once.** A `Sent` sheet logs every ticket and is the source of truth for dedupe.
- **Configured from a sheet.** Statuses, recipients, form link, sender and templates all live in a `Config` tab.

```
every N min ─► Jira search: project in (…) AND status CHANGED TO "<status>" AFTER -Xm
            ─► for each new ticket: recipients from reporter / assignee / custom field
            ─► Gmail: send the form link (with the ticket key pre-filled) from your Google account
            ─► Sent sheet: log it, so it is never emailed again
```

## Install

You need a Google account to send from (personal Gmail or Google Workspace) and a Jira Cloud account that can see the projects.

### Option A: paste into a sheet (about 2 minutes)
1. Create a Google Sheet **while signed in as the account that should send the emails**.
2. Go to **Extensions → Apps Script**. Replace the contents of `Code.gs` with [`src/Code.js`](src/Code.js) and save.
3. Reload the sheet. A **Feedback Mailer** menu appears.
4. Continue with [Configure](#configure).

### Option B: clasp (for developers; keeps the deployment in sync with this repo)
```bash
git clone <this repo> && cd jira-feedback-mailer
npm install
npx clasp login                      # once per machine
cp .clasp.json.example .clasp.json   # then paste your script ID into it
npm run push                         # uploads src/ to the Apps Script project
```
The script ID is in the Apps Script editor under **Project Settings → IDs**. Create the project from a sheet first (Option A, steps 1–2) so it is bound to that sheet. `.clasp.json` is gitignored because every deployment has its own.

> clasp needs the Apps Script API turned on for your account: https://script.google.com/home/usersettings

## Configure

1. **Feedback Mailer → 1. Setup**, then approve the permissions. Google shows *"Google hasn't verified this app"* for any personal script: click **Advanced → Go to … (unsafe) → Allow**. Setup creates the `Config` and `Sent` tabs and a trigger that runs every 5 minutes.
2. Fill in the **`Config`** tab (see the reference below).
3. **Feedback Mailer → 2. Set Jira API token.** Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens> while signed in as the `JIRA_EMAIL` account. It is stored in Script Properties, not in the sheet.
4. **Feedback Mailer → 3. Check Jira access.** This shows who you're logged in as and lists the tickets currently in your status, with their recipients.
5. `DRY_RUN` is `TRUE` to begin with, so the `Sent` tab only shows who *would* be emailed. When that looks right, set it to `FALSE`.

### Config reference

| Setting | Example | Notes |
|---|---|---|
| `JIRA_BASE_URL` | `https://acme.atlassian.net` | A pasted board or issue link also works |
| `JIRA_EMAIL` | `bot@acme.com` | Must be the account that created the API token |
| `PROJECT_KEYS` | `ABC, OPS` | The part before the dash in `ABC-123` |
| `TRIGGER_STATUS` | `Done` or `Awaiting payment, Closed` | Exact status names. Comma-separated for several |
| `EXTRA_JQL` | `issuetype = Task AND labels != no-feedback` | Optional extra filter |
| `RECIPIENT_FIELD` | `reporter` | `reporter`, `assignee`, `creator`, or `customfield_12345`. A custom field can hold a user, several users, or email text |
| `FROM_ADDRESS` | *(blank)* | Blank = the account that ran Setup. Anything else must be a Gmail **Send mail as** alias of that account |
| `FROM_NAME` | `Support Team` | Sender display name |
| `REPLY_TO`, `CC`, `BCC` | `team@acme.com` | Optional. `BCC` to a shared inbox gives you an audit trail |
| `FORM_URL` | `https://docs.google.com/forms/d/e/…/viewform?usp=pp_url&entry.123={key}` | See [Form link](#form-link) |
| `EMAIL_SUBJECT` | `Feedback on {key}` | Placeholders below |
| `EMAIL_BODY_HTML` | `<p>Hi {recipient_name}…</p>` | Placeholders below. A plain-text version is generated automatically |
| `DRY_RUN` | `TRUE` | `TRUE` = log only, no emails |
| `POLL_MINUTES` | `5` | 1, 5, 10, 15 or 30. Run **Setup** again after changing it |
| `INITIAL_LOOKBACK_MINUTES` | `60` | How far back the first run (or a **Re-scan**) looks |
| `OVERLAP_MINUTES` | `10` | Extra look-back on each run, so a slow run never misses a change |
| `MAX_ATTEMPTS` | `3` | How many times a failed send is retried |

**Placeholders:** `{key}` `{summary}` `{status}` `{recipient_name}` `{email}` `{issue_url}` `{form_link}`. They are URL-encoded inside `FORM_URL` and HTML-escaped inside the body.

If you set up an older version, run **Setup** again. It adds any new settings to `Config` and keeps your existing values.

### Form link
In Google Forms: **⋮ → Get pre-filled link**. Type `TEST` into a short-answer "Ticket" question, click **Get link → Copy link**, then replace `TEST` with `{key}`. Responses will then show which ticket they're about.

## Day-to-day

**`Sent` tab statuses**

| Status | Meaning | What to do |
|---|---|---|
| `SENT` | Emailed | Nothing. It will never be sent again |
| `DRY_RUN` | Would have been emailed while `DRY_RUN` was on | Not sent when you go live. Use **Allow re-send** to send it |
| `NO_EMAIL` | Recipient field empty, or the email is hidden by Atlassian privacy settings | Type the address into **Recipients**, then **Allow re-send for selected row** |
| `FAILED` | The send failed; the reason is in **Last error** | Retried automatically up to `MAX_ATTEMPTS` |
| `SENDING` | The run stopped mid-send | Not retried, to avoid duplicates. Check, then use **Allow re-send** if needed |

**Menu:** **Run now** · **Allow re-send for selected row** · **Re-scan from INITIAL_LOOKBACK_MINUTES**, which catches up after downtime with no duplicates · **Stop (remove my trigger)**.

**Logs:** Extensions → Apps Script → **Executions**. Each run logs how many tickets it checked and the exact JQL it used.

## Things to know

- **Run only one copy.** Each copy of the sheet has its own `Sent` log, so two copies with triggers email every ticket twice. Before you use **File → Make a copy**, stop the trigger in the original. Copies don't bring over the trigger or the token, so run **Setup** and **Set Jira API token** in the new copy.
- **Triggers belong to whoever ran Setup**, and emails are sent from that account. Only that account can remove its trigger.
- **Reporter emails can be hidden.** Jira only returns a user's email when their Atlassian profile allows it. **Check Jira access** shows which ones are hidden. Fix them with a custom email field (`RECIPIENT_FIELD`) or by typing the address into the row.
- **A wrong token doesn't produce an obvious error in Jira.** Jira answers as an anonymous user with 0 results. The script detects this and reports "Jira rejected the login".
- **Quotas:** Gmail allows about 100 recipients a day on a personal account and about 1,500 on Workspace. Each run must finish within 6 minutes.
- **Security:** anyone who can edit the sheet can open the script and read its Script Properties, which include the token. Share edit access only with people you trust. Use a dedicated Jira account with read-only access to the relevant projects.

## Development

```bash
npm test        # unit tests for the pure helpers (Node 18+, no Google account needed)
npm run push    # deploy src/ to the Apps Script project in .clasp.json
npm run pull    # pull edits made in the online editor back into src/
```

This repository holds the master copy. Make changes here, run the tests, then `npm run push`, or paste into each deployment by hand.

## License

[MIT](LICENSE)
