// Unit tests for the pure helpers in src/Code.js. Run: npm test  (Node 18+, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.js'), 'utf8'), ctx);
const g = name => vm.runInContext(name, ctx);

const cfg = over => Object.assign(
  Object.fromEntries(g('DEFAULT_CONFIG').map(([k, v]) => [k, v])),
  { JIRA_BASE_URL: 'https://acme.atlassian.net', PROJECT_KEYS: 'abc, OPS', TRIGGER_STATUS: 'Awaiting payment' },
  over);

test('jiraBase_ strips paths from pasted links', () => {
  assert.equal(g('jiraBase_')(cfg({ JIRA_BASE_URL: 'https://Acme.atlassian.net/jira/software/projects/ABC/boards/1?x=y' })),
               'https://acme.atlassian.net');
  assert.equal(g('jiraBase_')(cfg({ JIRA_BASE_URL: '' })), '');
});

test('projectClause_ normalises keys and rejects issue keys', () => {
  assert.equal(g('projectClause_')(cfg()), 'project in (ABC, OPS)');
  assert.throws(() => g('projectClause_')(cfg({ PROJECT_KEYS: 'ABC-' })), /Invalid project key/);
});

test('buildPollJql_ handles several statuses, quoting and extra JQL', () => {
  const jql = g('buildPollJql_')(cfg({ TRIGGER_STATUS: 'Awaiting payment, Say "hi"', EXTRA_JQL: 'issuetype = Task' }), 15);
  assert.equal(jql, 'project in (ABC, OPS) AND (status CHANGED TO "Awaiting payment" AFTER -15m OR ' +
    'status CHANGED TO "Say \\"hi\\"" AFTER -15m) AND (issuetype = Task) ORDER BY updated ASC');
});

test('recipientField_ accepts known fields and custom fields only', () => {
  assert.equal(g('recipientField_')(cfg({ RECIPIENT_FIELD: ' Reporter ' })), 'reporter');
  assert.equal(g('recipientField_')(cfg({ RECIPIENT_FIELD: 'customfield_10050' })), 'customfield_10050');
  assert.throws(() => g('recipientField_')(cfg({ RECIPIENT_FIELD: 'summary' })), /RECIPIENT_FIELD/);
});

test('recipientsFrom_ reads users, user lists, text and hidden emails', () => {
  const f = g('recipientsFrom_');
  assert.deepEqual(JSON.parse(JSON.stringify(f({ fields: { reporter: { displayName: 'Ann', emailAddress: 'a@x.com' } } }, 'reporter'))),
                   { emails: ['a@x.com'], name: 'Ann' });
  assert.deepEqual([...f({ fields: { customfield_1: [{ emailAddress: 'a@x.com' }, { emailAddress: 'B@x.com' }] } }, 'customfield_1').emails],
                   ['a@x.com', 'B@x.com']);
  assert.deepEqual([...f({ fields: { customfield_1: 'a@x.com; b@x.com, nope, a@x.com' } }, 'customfield_1').emails],
                   ['a@x.com', 'b@x.com']);
  const hidden = f({ fields: { reporter: { displayName: 'Hidden' } } }, 'reporter');
  assert.equal(hidden.emails.length, 0);
  assert.equal(hidden.name, 'Hidden');
  assert.equal(f({ fields: { reporter: null } }, 'reporter').emails.length, 0);
});

test('fill_ encodes per context; htmlToText_ makes a readable plain-text body', () => {
  const vars = { key: 'ABC-1', summary: 'Fish & <chips>' };
  assert.equal(g('fill_')('u?k={key}&s={summary}&x={unknown}', vars, encodeURIComponent),
               'u?k=ABC-1&s=Fish%20%26%20%3Cchips%3E&x={unknown}');
  const html = g('fill_')('<p>{summary}</p><p><a href="https://f?a=1&amp;b=2">Go</a></p>', vars, g('escapeHtml_'));
  assert.equal(html, '<p>Fish &amp; &lt;chips&gt;</p><p><a href="https://f?a=1&amp;b=2">Go</a></p>');
  assert.equal(g('htmlToText_')(html), 'Fish & <chips>\nGo: https://f?a=1&b=2');
});

test('fieldText_ reads select, multi-select, cascading, user, number and rich-text values', () => {
  const f = g('fieldText_');
  assert.equal(f({ value: 'Finance', id: '1' }), 'Finance');
  assert.equal(f([{ value: 'Hardware' }, { value: 'Software' }]), 'Hardware, Software');
  assert.equal(f({ value: 'IT', child: { value: 'Laptops' } }), 'IT - Laptops');
  assert.equal(f({ displayName: 'Ann', accountId: 'x' }), 'Ann');
  assert.equal(f(42), '42');
  assert.equal(f(null), '');
  assert.equal(f({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Office ' }, { type: 'text', text: 'chairs' }] }] }),
               'Office chairs');
});

test('extraFields_ parses ids without calling Jira and rejects bad items', () => {
  const f = g('extraFields_');
  assert.deepEqual(JSON.parse(JSON.stringify(f(cfg({ EXTRA_FIELDS: 'department=customfield_10050, cat = CustomField_10051' })))),
                   [{ name: 'department', id: 'customfield_10050' }, { name: 'cat', id: 'customfield_10051' }]);
  assert.equal(f(cfg({ EXTRA_FIELDS: '' })).length, 0);
  assert.throws(() => f(cfg({ EXTRA_FIELDS: 'Category of Purchase' })), /must look like/);
});

test('extraValues_ maps placeholders to field text', () => {
  const extras = [{ name: 'department', id: 'customfield_1' }, { name: 'purchase_category', id: 'customfield_2' }];
  const issue = { fields: { customfield_1: { value: 'Finance' }, customfield_2: null } };
  assert.deepEqual(JSON.parse(JSON.stringify(g('extraValues_')(issue, extras))), { department: 'Finance', purchase_category: '' });
});
