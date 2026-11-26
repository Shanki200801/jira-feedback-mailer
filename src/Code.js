/**
 * Jira Feedback Mailer (Google Apps Script, bound to a Google Sheet). See README.md for setup.
 *
 * Every few minutes: finds Jira Cloud tickets that moved into one of TRIGGER_STATUS,
 * emails the configured recipients a pre-filled Google Form link, and logs each ticket
 * in the "Sent" sheet so it is never emailed twice.
 *
 * All settings live in the "Config" sheet. The Jira API token lives in Script Properties
 * (menu: Feedback Mailer → Set Jira API token), never in the sheet.
 */

const CONFIG_SHEET = 'Config';
const SENT_SHEET = 'Sent';
const SENT_HEADERS = ['Issue key', 'Recipients', 'Recipient name', 'Summary', 'Status',
                      'Attempts', 'Last error', 'First seen', 'Updated', 'Extra fields'];
const COL = { key: 1, email: 2, name: 3, summary: 4, status: 5, attempts: 6, error: 7, first: 8, updated: 9, extra: 10 };

// Rows in these states are never emailed again (use "Allow re-send for selected row" to override).
// DRY_RUN is final so switching DRY_RUN off does not email a backlog of old tickets.
const FINAL_STATES = ['SENT', 'SENDING', 'NO_EMAIL', 'SKIPPED', 'DRY_RUN'];

const DEFAULT_CONFIG = [
  // Jira
  ['JIRA_BASE_URL', 'https://your-site.atlassian.net', 'Jira Cloud site URL (a pasted board or issue link also works)'],
  ['JIRA_EMAIL', 'you@example.com', 'Email of the Atlassian account that created the API token'],
  ['PROJECT_KEYS', 'ABC', 'Comma-separated project keys (the part before the dash in ABC-123)'],
  ['TRIGGER_STATUS', 'Done', 'Status name(s) that trigger the email. Comma-separated for several'],
  ['EXTRA_JQL', '', 'Optional extra JQL filter, e.g.  issuetype = Task AND labels != no-feedback'],
  ['RECIPIENT_FIELD', 'reporter',
   'Who gets the email: reporter, assignee, creator, or a custom field id (customfield_12345) holding user(s) or email text'],
  ['EXTRA_FIELDS', '',
   'Optional extra Jira fields as placeholders: name=Jira field name or id, comma-separated. ' +
   'E.g.  department=Department, purchase_category=Category of Purchase  gives {department} {purchase_category}'],
  // Email
  ['FROM_ADDRESS', '', 'Blank = the Google account that ran Setup. Otherwise must be a Gmail "Send mail as" alias of it'],
  ['FROM_NAME', 'Feedback', 'Sender display name'],
  ['REPLY_TO', '', 'Optional reply-to address'],
  ['CC', '', 'Optional comma-separated CC addresses'],
  ['BCC', '', 'Optional comma-separated BCC addresses (e.g. a shared inbox for audit)'],
  ['FORM_URL', 'https://docs.google.com/forms/d/e/FORM_ID/viewform?usp=pp_url&entry.111111={key}',
   'Pre-filled form link. Placeholders: {key} {email} {summary} {status} {recipient_name} {issue_url} + EXTRA_FIELDS'],
  ['EMAIL_SUBJECT', 'We would love your feedback on {key}',
   'Placeholders: {key} {summary} {status} {recipient_name}'],
  ['EMAIL_BODY_HTML',
   '<p>Hi {recipient_name},</p><p>Your ticket <b>{key}</b> ({summary}) has moved to <b>{status}</b>. ' +
   'We would appreciate a minute of your feedback:</p><p><a href="{form_link}">Share feedback</a></p><p>Thank you!</p>',
   'HTML body. Placeholders: {key} {summary} {status} {recipient_name} {form_link} {issue_url}'],
  // Behaviour
  ['DRY_RUN', 'TRUE', 'TRUE = log only, no emails sent. Set FALSE to go live'],
  ['POLL_MINUTES', '5', 'How often the trigger runs: 1, 5, 10, 15 or 30 (re-run Setup after changing)'],
  ['INITIAL_LOOKBACK_MINUTES', '60', 'First run (or after "Re-scan"): how far back to look'],
  ['OVERLAP_MINUTES', '10', 'Extra look-back each run so no change is missed'],
  ['MAX_ATTEMPTS', '3', 'Retries for failed sends'],
];

// ---------------------------------------------------------------- menu & setup

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Feedback Mailer')
    .addItem('1. Setup (create sheets + trigger)', 'setup')
    .addItem('2. Set Jira API token', 'promptForToken')
    .addItem('3. Check Jira access', 'checkJiraAccess')
    .addSeparator()
    .addItem('Run now', 'poll')
    .addItem('Allow re-send for selected row', 'resetSelectedRow')
    .addItem('Re-scan from INITIAL_LOOKBACK_MINUTES', 'rescan')
    .addItem('Stop (remove my trigger)', 'removeTriggers')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  let config = ss.getSheetByName(CONFIG_SHEET);
  if (!config) {
    config = ss.insertSheet(CONFIG_SHEET);
    config.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'Notes']]).setFontWeight('bold');
    config.setColumnWidth(1, 220).setColumnWidth(2, 420).setColumnWidth(3, 480);
    config.getRange('B:B').setWrap(true);
    config.setFrozenRows(1);
  }
  // Add any settings missing from an older Config sheet, keeping existing values.
  const existing = config.getLastRow() > 1
    ? config.getRange(2, 1, config.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim())
    : [];
  const missing = DEFAULT_CONFIG.filter(([k]) => existing.indexOf(k) === -1);
  if (missing.length) {
    config.getRange(config.getLastRow() + 1, 1, missing.length, 3).setNumberFormat('@').setValues(missing);
  }

  let sent = ss.getSheetByName(SENT_SHEET);
  if (!sent) {
    sent = ss.insertSheet(SENT_SHEET);
    sent.setFrozenRows(1);
  }
  sent.getRange(1, 1, 1, SENT_HEADERS.length).setValues([SENT_HEADERS]).setFontWeight('bold');

  const first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && first.getLastRow() === 0) ss.deleteSheet(first);

  const minutes = Number(getConfig_().POLL_MINUTES) || 5;
  installTrigger_(minutes);
  SpreadsheetApp.getUi().alert(`Setup done. Runs every ${minutes} min as ${Session.getEffectiveUser().getEmail()}.\n\n` +
    'Next: fill in the Config sheet, then "Set Jira API token" and "Check Jira access".\n' +
    'DRY_RUN stays TRUE (no emails) until you change it.\n\n' +
    'Only ONE copy of this sheet should have a trigger, otherwise tickets are emailed twice.');
}

function installTrigger_(minutes) {
  if ([1, 5, 10, 15, 30].indexOf(minutes) === -1) throw new Error('POLL_MINUTES must be 1, 5, 10, 15 or 30.');
  removeTriggers(true);
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(minutes).create();
}

/** Removes the current user's poll trigger (triggers belong to whoever ran Setup). */
function removeTriggers(silent) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'poll')
    .forEach(t => ScriptApp.deleteTrigger(t));
  if (silent !== true) SpreadsheetApp.getUi().alert('Your trigger was removed. No more automatic runs from your account.');
}

function promptForToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Jira API token',
    'Paste the API token created by the JIRA_EMAIL account.\nIt is stored in Script Properties, not in the sheet.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const token = res.getResponseText().trim();
  if (!token) return ui.alert('No token entered.');
  PropertiesService.getScriptProperties().setProperty('JIRA_API_TOKEN', token);
  ui.alert('Token saved. Now run "Check Jira access".');
}

/** Confirms the login, and lists a few tickets currently in TRIGGER_STATUS with their recipients. */
function checkJiraAccess() {
  const ui = SpreadsheetApp.getUi();
  try {
    const cfg = getConfig_();
    const me = jiraGet_(cfg, '/rest/api/3/myself');
    const field = recipientField_(cfg);
    const statuses = list_(cfg.TRIGGER_STATUS).map(jqlString_).join(', ');
    let jql = `${projectClause_(cfg)} AND status in (${statuses})`;
    if (String(cfg.EXTRA_JQL || '').trim()) jql += ` AND (${cfg.EXTRA_JQL.trim()})`;
    jql += ' ORDER BY updated DESC';
    const extras = extraFields_(cfg);
    const issues = searchJira_(cfg, jql, 5, extras);

    let msg = `Logged in to Jira as ${me.displayName || '?'} (${me.emailAddress || 'email hidden'}).\n\n`;
    if (!issues.length) {
      msg += `No tickets are currently in ${statuses}.\nIf you expected some, check PROJECT_KEYS, TRIGGER_STATUS, ` +
             `EXTRA_JQL, and that this Jira account can open those tickets.\n\nJQL: ${jql}`;
      return ui.alert(msg);
    }
    let hidden = 0;
    msg += `Recipients from "${field}":\n` + issues.map(i => {
      const r = recipientsFrom_(i, field);
      if (!r.emails.length) hidden++;
      const x = extraValues_(i, extras);
      const xs = Object.keys(x).map(k => `  {${k}} = ${x[k] || '(empty)'}`).join('\n');
      return `${i.key}: ${r.emails.join(', ') || '⚠ no visible email'}` + (xs ? '\n' + xs : '');
    }).join('\n');
    if (hidden) msg += `\n\n⚠ ${hidden} ticket(s) have no visible email (empty field, or hidden by Atlassian ` +
                       'privacy settings). They will be logged as NO_EMAIL.';
    ui.alert(msg);
  } catch (e) {
    ui.alert('Jira check failed:\n\n' + e.message);
  }
}

function resetSelectedRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const row = sheet.getActiveRange().getRow();
  if (sheet.getName() !== SENT_SHEET || row < 2) {
    return SpreadsheetApp.getUi().alert('Select a ticket row in the Sent sheet first.');
  }
  sheet.getRange(row, COL.status).setValue('FAILED');
  sheet.getRange(row, COL.attempts).setValue(0);
  SpreadsheetApp.getUi().alert('Row will be sent on the next run (edit the Recipients cell first if needed).');
}

function rescan() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_POLL_MS');
  SpreadsheetApp.getUi().alert('The next run will look back INITIAL_LOOKBACK_MINUTES. ' +
    'Tickets already in the Sent sheet are still never emailed twice.');
}

// ---------------------------------------------------------------- main job

function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return console.log('Previous run still in progress, skipping.');
  try {
    const cfg = getConfig_();
    const field = recipientField_(cfg);
    const props = PropertiesService.getScriptProperties();
    const startedAt = Date.now();
    const last = Number(props.getProperty('LAST_POLL_MS')) || 0;
    const lookback = last
      ? Math.ceil((startedAt - last) / 60000) + Number(cfg.OVERLAP_MINUTES || 10)
      : Number(cfg.INITIAL_LOOKBACK_MINUTES || 60);

    const jql = buildPollJql_(cfg, lookback);
    const extras = extraFields_(cfg);
    const issues = searchJira_(cfg, jql, 500, extras);

    const log = new SentLog_();
    issues.forEach(issue => {
      const r = recipientsFrom_(issue, field);
      const x = extras.length ? JSON.stringify(extraValues_(issue, extras)) : '';
      log.upsertSeen(issue.key, r.emails.join(', '), r.name, issue.fields.summary || '',
                     ((issue.fields.status || {}).name) || '', x);
    });

    const maxAttempts = Number(cfg.MAX_ATTEMPTS || 3);
    log.pending(maxAttempts).forEach(row => processRow_(cfg, log, row));

    // Only advance the watermark after a successful search.
    props.setProperty('LAST_POLL_MS', String(startedAt));
    console.log(`Checked ${issues.length} ticket(s) with look-back ${lookback}m. JQL: ${jql}`);
  } finally {
    lock.releaseLock();
  }
}

function buildPollJql_(cfg, lookback) {
  const statuses = list_(cfg.TRIGGER_STATUS);
  if (!statuses.length) throw new Error('TRIGGER_STATUS is empty in the Config sheet.');
  const changed = statuses.map(s => `status CHANGED TO ${jqlString_(s)} AFTER -${lookback}m`).join(' OR ');
  let jql = `${projectClause_(cfg)} AND (${changed})`;
  if (String(cfg.EXTRA_JQL || '').trim()) jql += ` AND (${cfg.EXTRA_JQL.trim()})`;
  return jql + ' ORDER BY updated ASC';
}

function processRow_(cfg, log, row) {
  if (!row.emails.length) {
    log.update(row.index, 'NO_EMAIL', row.attempts, 'No visible email in ' + recipientField_(cfg));
    return;
  }
  if (isTrue_(cfg.DRY_RUN)) {
    log.update(row.index, 'DRY_RUN', row.attempts, 'Would email ' + row.emails.join(', '));
    return;
  }
  // Mark SENDING first: if the run dies mid-send, the ticket is never emailed twice.
  log.update(row.index, 'SENDING', row.attempts + 1, '');
  SpreadsheetApp.flush();
  try {
    sendFeedbackEmail_(cfg, row);
    log.update(row.index, 'SENT', row.attempts + 1, '');
  } catch (e) {
    log.update(row.index, 'FAILED', row.attempts + 1, String(e.message || e).slice(0, 500));
  }
}

function sendFeedbackEmail_(cfg, row) {
  const vars = Object.assign(parseExtra_(row.extra), {
    key: row.key,
    summary: row.summary,
    status: row.status || list_(cfg.TRIGGER_STATUS)[0] || '',
    recipient_name: row.name || 'there',
    reporter_name: row.name || 'there', // alias kept for older templates
    email: row.emails.join(','),
    issue_url: jiraBase_(cfg) + '/browse/' + row.key,
  }); // built-in placeholders win over EXTRA_FIELDS names
  vars.form_link = fill_(cfg.FORM_URL, vars, encodeURIComponent);

  const subject = fill_(cfg.EMAIL_SUBJECT, vars, s => s);
  const html = fill_(cfg.EMAIL_BODY_HTML, vars, escapeHtml_);
  const text = htmlToText_(html);

  const options = { htmlBody: html };
  if (cfg.FROM_NAME) options.name = cfg.FROM_NAME;
  const from = String(cfg.FROM_ADDRESS || '').trim();
  if (from && from.toLowerCase() !== Session.getEffectiveUser().getEmail().toLowerCase()) options.from = from;
  if (String(cfg.REPLY_TO || '').trim()) options.replyTo = cfg.REPLY_TO.trim();
  if (emails_(cfg.CC).length) options.cc = emails_(cfg.CC).join(',');
  if (emails_(cfg.BCC).length) options.bcc = emails_(cfg.BCC).join(',');
  GmailApp.sendEmail(row.emails.join(','), subject, text, options);
}

// ---------------------------------------------------------------- Jira

function searchJira_(cfg, jql, limit, extras) {
  const fields = ['summary', 'status', recipientField_(cfg)].concat((extras || []).map(x => x.id)).join(',');
  const out = [];
  let pageToken = null;
  do {
    let path = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}` +
               `&maxResults=${Math.min(limit, 100)}`;
    if (pageToken) path += '&nextPageToken=' + encodeURIComponent(pageToken);
    const body = jiraGet_(cfg, path);
    out.push(...(body.issues || []));
    pageToken = body.isLast === false ? body.nextPageToken : null;
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}

function jiraGet_(cfg, path) {
  const token = PropertiesService.getScriptProperties().getProperty('JIRA_API_TOKEN');
  if (!token) throw new Error('Jira API token not set (menu: Feedback Mailer → Set Jira API token).');
  const base = jiraBase_(cfg);
  if (!/^https:\/\/[^/]+\.atlassian\.net$/.test(base) || /your-site/.test(base)) {
    throw new Error('Set JIRA_BASE_URL in the Config sheet to your Jira Cloud site, e.g. https://acme.atlassian.net');
  }
  if (!String(cfg.JIRA_EMAIL || '').trim() || /@example\.com$/.test(cfg.JIRA_EMAIL)) {
    throw new Error('Set JIRA_EMAIL in the Config sheet.');
  }
  const auth = 'Basic ' + Utilities.base64Encode(cfg.JIRA_EMAIL.trim() + ':' + token);
  const res = fetchWithRetry_(base + path,
    { headers: { Authorization: auth, Accept: 'application/json' }, muteHttpExceptions: true });
  return JSON.parse(res.getContentText() || '{}');
}

function fetchWithRetry_(url, options) {
  for (let attempt = 1; ; attempt++) {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code === 200) {
      // Jira Cloud answers a bad email/token as an anonymous user (HTTP 200, zero results) instead of 401.
      const h = lowerKeys_(res.getHeaders());
      if (/AUTHENTICATED_FAILED|AUTHENTICATION_DENIED/i.test(h['x-seraph-loginreason'] || '') ||
          (h['x-ausername'] || '').toLowerCase() === 'anonymous') {
        throw new Error('Jira rejected the login (treated as anonymous). Check JIRA_EMAIL matches the account ' +
                        'that created the API token, then set the token again from the menu.');
      }
      return res;
    }
    if ((code === 429 || code >= 500) && attempt < 4) {
      const retryAfter = Number(lowerKeys_(res.getHeaders())['retry-after']);
      Utilities.sleep(Math.min(retryAfter * 1000 || 2000 * attempt, 20000));
      continue;
    }
    const hint = code === 401 ? ' (check JIRA_EMAIL and the API token)'
               : code === 400 ? ' (check PROJECT_KEYS, TRIGGER_STATUS, EXTRA_JQL and RECIPIENT_FIELD)' : '';
    throw new Error(`Jira returned HTTP ${code}${hint}: ${res.getContentText().slice(0, 300)}`);
  }
}

/** Site root from JIRA_BASE_URL; tolerates a pasted board/issue link. */
function jiraBase_(cfg) {
  const m = String(cfg.JIRA_BASE_URL || '').trim().match(/^https?:\/\/[^/?#]+/i);
  return m ? m[0].toLowerCase().replace(/^http:/, 'https:') : '';
}

function projectClause_(cfg) {
  const keys = list_(cfg.PROJECT_KEYS).map(k => k.toUpperCase());
  if (!keys.length) throw new Error('PROJECT_KEYS is empty in the Config sheet.');
  keys.forEach(k => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid project key "${k}" (use ABC, not ABC-123).`);
  });
  return `project in (${keys.join(', ')})`;
}

function recipientField_(cfg) {
  const f = String(cfg.RECIPIENT_FIELD || 'reporter').trim();
  const lower = f.toLowerCase();
  if (['reporter', 'assignee', 'creator'].indexOf(lower) !== -1) return lower;
  if (/^customfield_\d+$/i.test(f)) return lower;
  throw new Error(`RECIPIENT_FIELD "${f}" must be reporter, assignee, creator or customfield_<number>.`);
}

/** Pulls email addresses (and a display name) out of a user, user list, or text field. */
function recipientsFrom_(issue, field) {
  const found = [];
  let name = '';
  const take = v => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) return v.forEach(take);
    if (typeof v === 'string') return found.push(...v.split(/[,;\s]+/));
    if (typeof v === 'object') {
      if (v.displayName && !name) name = v.displayName;
      if (v.emailAddress) return found.push(v.emailAddress);
      if (v.value) return take(v.value);
    }
  };
  take((issue.fields || {})[field]);
  return { emails: emails_(found.join(',')), name: name };
}

/**
 * Parses EXTRA_FIELDS ("department=Department, cat=customfield_10051") into [{name, id}],
 * resolving Jira field names to ids. Returns [] when unset.
 */
function extraFields_(cfg) {
  const specs = list_(cfg.EXTRA_FIELDS).map(item => {
    const m = item.match(/^(\w+)\s*=\s*(.+)$/);
    if (!m) throw new Error(`EXTRA_FIELDS item "${item}" must look like  placeholder=Jira field name`);
    return { name: m[1], field: m[2].trim() };
  });
  if (!specs.length) return [];
  let all = null;
  return specs.map(s => {
    if (/^customfield_\d+$/i.test(s.field)) return { name: s.name, id: s.field.toLowerCase() };
    all = all || jiraGet_(cfg, '/rest/api/3/field');
    const hits = all.filter(f => f.id === s.field || String(f.name).toLowerCase() === s.field.toLowerCase());
    const ids = hits.map(f => f.id).filter((id, i, a) => a.indexOf(id) === i);
    if (!ids.length) throw new Error(`EXTRA_FIELDS: no Jira field named "${s.field}".`);
    if (ids.length > 1) {
      throw new Error(`EXTRA_FIELDS: several Jira fields are named "${s.field}" (${ids.join(', ')}). Use the id instead.`);
    }
    return { name: s.name, id: ids[0] };
  });
}

/** {placeholder: text} for an issue's extra fields. */
function extraValues_(issue, extras) {
  const out = {};
  extras.forEach(x => { out[x.name] = fieldText_((issue.fields || {})[x.id]); });
  return out;
}

/** Readable text from any Jira field value: text, number, select, multi-select, cascading, user, rich text. */
function fieldText_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(fieldText_).filter(Boolean).join(', ');
  if (v.type === 'doc' || v.type === 'paragraph' || Array.isArray(v.content)) {
    return (v.text || '') + (v.content || []).map(fieldText_).join(v.type === 'doc' ? '\n' : '').trim();
  }
  if (v.type === 'text') return v.text || '';
  const own = v.value !== undefined ? String(v.value) : (v.displayName || v.name || v.key || '');
  return v.child ? `${own} - ${fieldText_(v.child)}` : own;
}

function parseExtra_(s) {
  try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; }
}

function jqlString_(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------- Sent log (sheet)

function SentLog_() {
  this.sheet = SpreadsheetApp.getActive().getSheetByName(SENT_SHEET);
  if (!this.sheet) throw new Error('Sent sheet missing. Run Feedback Mailer → Setup.');
  const n = this.sheet.getLastRow() - 1;
  this.rows = n > 0 ? this.sheet.getRange(2, 1, n, SENT_HEADERS.length).getValues() : [];
  this.byKey = {};
  this.statusByKey = {};
  this.rows.forEach((r, i) => { if (r[0]) this.byKey[r[0]] = i; });
}

SentLog_.prototype.upsertSeen = function (key, emails, name, summary, jiraStatus, extra) {
  this.statusByKey[key] = jiraStatus;
  const now = new Date();
  if (key in this.byKey) {
    const i = this.byKey[key];
    const r = this.rows[i];
    if (FINAL_STATES.indexOf(r[COL.status - 1]) === -1 && emails && !r[COL.email - 1]) {
      r[COL.email - 1] = emails; // recipient became visible / was filled in
      this.sheet.getRange(i + 2, COL.email).setValue(emails);
    }
    if (FINAL_STATES.indexOf(r[COL.status - 1]) === -1 && extra && !r[COL.extra - 1]) {
      r[COL.extra - 1] = extra;
      this.sheet.getRange(i + 2, COL.extra).setValue(extra);
    }
    return;
  }
  const row = [key, emails, name, summary, 'NEW', 0, '', now, now, extra || ''];
  this.sheet.appendRow(row);
  this.byKey[key] = this.rows.length;
  this.rows.push(row);
};

/** Rows that still need an email: NEW, or FAILED with attempts left. */
SentLog_.prototype.pending = function (maxAttempts) {
  const out = [];
  this.rows.forEach((r, i) => {
    const status = r[COL.status - 1];
    const attempts = Number(r[COL.attempts - 1]) || 0;
    if (!r[0] || FINAL_STATES.indexOf(status) !== -1) return;
    if (status === 'FAILED' && attempts >= maxAttempts) return;
    out.push({ index: i, key: r[0], emails: emails_(r[COL.email - 1]), name: r[COL.name - 1],
               summary: r[COL.summary - 1], status: this.statusByKey[r[0]] || '', attempts: attempts,
               extra: r[COL.extra - 1] });
  });
  return out;
};

SentLog_.prototype.update = function (index, status, attempts, error) {
  const r = this.rows[index];
  r[COL.status - 1] = status; r[COL.attempts - 1] = attempts; r[COL.error - 1] = error; r[COL.updated - 1] = new Date();
  this.sheet.getRange(index + 2, COL.status, 1, 5)
    .setValues([[status, attempts, error, r[COL.first - 1], r[COL.updated - 1]]]);
};

// ---------------------------------------------------------------- helpers

function getConfig_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG_SHEET);
  if (!sheet) throw new Error('Config sheet missing. Run Feedback Mailer → Setup.');
  const cfg = {};
  DEFAULT_CONFIG.forEach(([k, v]) => { cfg[k] = v; });
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues()
      .forEach(([k, v]) => { if (k) cfg[String(k).trim()] = String(v); });
  }
  return cfg;
}

function list_(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function emails_(s) {
  const seen = {};
  return String(s || '').split(/[,;\s]+/).map(x => x.trim())
    .filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))
    .filter(x => (seen[x.toLowerCase()] ? false : (seen[x.toLowerCase()] = true)));
}

function fill_(template, vars, encode) {
  return String(template).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? encode(String(vars[name])) : m));
}

function escapeHtml_(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlToText_(html) {
  return html.replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

function lowerKeys_(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(k => { out[k.toLowerCase()] = String(obj[k]); });
  return out;
}

function isTrue_(v) {
  return String(v).trim().toUpperCase() === 'TRUE';
}
