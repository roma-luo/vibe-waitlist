/**
 * vibe waitlist backend (Google Apps Script, bound to a Google Sheet).
 *
 * Setup (about 3 minutes):
 *  1. Create a new Google Sheet. Extensions → Apps Script. Replace Code.gs with this file. Save.
 *  2. In the toolbar, pick the function "setup" and press Run. Approve the permissions.
 *     This creates the Signups, Events, Spend and Summary tabs.
 *  3. Deploy → New deployment → type "Web app".
 *     Execute as: Me.  Who has access: Anyone.  → Deploy. Copy the Web app URL (ends in /exec).
 *  4. Paste that URL into ENDPOINT in config.js on the website.
 *
 * After editing this file later: Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy.
 * The URL stays the same.
 */

// ---------- settings ----------
var SEND_CONFIRMATION = false;   // true = email each new sign-up from the Google account that owns this script
var BRAND = 'vibe';
var SITE_URL = '';               // optional, used in the confirmation email
var HEADLINE_LEGEND = 'a = "A spark. That feels like you."   b = "Stop swiping. Start vibing."   c = "Meet people through their stories, not their selfies."';

// ---------- sheet layout ----------
var EVENTS = 'Events', SIGNUPS = 'Signups', SPEND = 'Spend', SUMMARY = 'Summary';
var EVENT_COLS = ['ts', 'date', 'event', 'visitor_id', 'session_id', 'channel', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_content', 'utm_term', 'headline_variant', 'device', 'in_app', 'referrer', 'page_url',
  'detail', 'is_test'];
var SIGNUP_COLS = ['signup_time', 'date', 'email', 'channel', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'utm_term', 'headline_variant', 'device', 'in_app', 'referrer', 'referred_by', 'ref_code',
  'city', 'top_interest', 'visitor_id', 'landing_url', 'form_location', 'is_test', 'unsubscribed'];
var ALLOWED_EVENTS = { page_view: 1, scroll_50: 1, cta_click: 1, orb_complete: 1, share_click: 1, signup: 1, survey: 1 };
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- web app ----------
function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ status: 'error', error: 'bad_json' }); }
  try {
    if (data.type === 'event') { logEvent_(data, data.event); return json_({ status: 'ok' }); }
    if (data.type === 'signup') return json_(handleSignup_(data));
    if (data.type === 'survey') return json_(handleSurvey_(data));
    return json_({ status: 'error', error: 'unknown_type' });
  } catch (err) {
    console.error(err);
    return json_({ status: 'error', error: 'server' });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'count') {
    var sh = sheet_(SIGNUPS), n = 0, last = sh.getLastRow();
    if (last > 1) {
      var testCol = SIGNUP_COLS.indexOf('is_test') + 1;
      var vals = sh.getRange(2, testCol, last - 1, 1).getValues();
      for (var i = 0; i < vals.length; i++) if (vals[i][0] !== 'test') n++;
    }
    return json_({ count: n });
  }
  if (p.action === 'unsubscribe') {
    var email = String(p.e || '').toLowerCase();
    var ok = email && p.t === token_(email) && markUnsubscribed_(email);
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 20px;line-height:1.5">' +
      (ok ? '<h2>You\'re unsubscribed.</h2><p>You won\'t get more emails from ' + BRAND + '.</p>'
          : '<h2>That link didn\'t work.</h2><p>Reply to any ' + BRAND + ' email and we\'ll remove you by hand.</p>') +
      '</div>').setTitle(BRAND);
  }
  return HtmlService.createHtmlOutput('<p style="font-family:system-ui">' + BRAND + ' waitlist endpoint is running.</p>');
}

// ---------- handlers ----------
function handleSignup_(d) {
  if (d.company) return { status: 'ok', ref_code: '' };   // honeypot: bots fill the hidden field
  var email = String(d.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { status: 'error', error: 'invalid_email' };

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  var code;
  try {
    var sh = sheet_(SIGNUPS);
    if (findRow_(sh, SIGNUP_COLS.indexOf('email') + 1, email)) return { status: 'duplicate' };
    code = newRefCode_(sh);
    var now = new Date();
    var row = {
      signup_time: now,
      date: Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      email: email,
      ref_code: code,
      city: '', top_interest: '', unsubscribed: ''
    };
    ['channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'headline_variant',
      'device', 'in_app', 'referrer', 'referred_by', 'visitor_id', 'landing_url', 'form_location', 'is_test']
      .forEach(function (k) { row[k] = d[k]; });
    sh.appendRow(SIGNUP_COLS.map(function (k) { return k === 'signup_time' ? row[k] : safe_(row[k]); }));
  } finally {
    lock.releaseLock();
  }
  logEvent_(d, 'signup', d.form_location);
  if (SEND_CONFIRMATION && d.is_test !== 'test') {
    try { sendConfirmation_(email); } catch (err) { console.error('confirmation email failed', err); }
  }
  return { status: 'ok', ref_code: code };
}

function handleSurvey_(d) {
  var email = String(d.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { status: 'error', error: 'invalid_email' };
  var sh = sheet_(SIGNUPS);
  var r = findRow_(sh, SIGNUP_COLS.indexOf('email') + 1, email);
  if (!r) return { status: 'error', error: 'not_found' };
  // Only the browser that signed up may answer (stops someone overwriting another person's answers).
  var owner = sh.getRange(r, SIGNUP_COLS.indexOf('visitor_id') + 1).getValue();
  if (owner && owner !== d.visitor_id) return { status: 'error', error: 'not_owner' };
  sh.getRange(r, SIGNUP_COLS.indexOf('city') + 1).setValue(safe_(d.city));
  sh.getRange(r, SIGNUP_COLS.indexOf('top_interest') + 1).setValue(safe_(d.top_interest));
  logEvent_(d, 'survey', [d.city, d.top_interest].filter(String).join(' | '));
  return { status: 'ok' };
}

function logEvent_(d, eventName, detail) {
  if (!ALLOWED_EVENTS[eventName]) return;
  var now = new Date();
  var row = {
    ts: now,
    date: Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    event: eventName,
    detail: detail !== undefined ? detail : d.detail
  };
  EVENT_COLS.forEach(function (k) { if (!(k in row)) row[k] = d[k]; });
  sheet_(EVENTS).appendRow(EVENT_COLS.map(function (k) { return k === 'ts' ? row[k] : safe_(row[k]); }));
}

// ---------- email ----------
function sendConfirmation_(email) {
  var unsub = ScriptApp.getService().getUrl() + '?action=unsubscribe&e=' + encodeURIComponent(email) + '&t=' + token_(email);
  var site = SITE_URL ? '<p><a href="' + SITE_URL + '">' + SITE_URL + '</a></p>' : '';
  MailApp.sendEmail({
    to: email,
    name: BRAND,
    subject: "You're on the " + BRAND + ' waitlist',
    body: "You're on the list.\n\n" + BRAND + " isn't live yet. We'll email you the moment it launches in New York City.\n\n" +
      'Unsubscribe: ' + unsub,
    htmlBody:
      '<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;line-height:1.55;color:#1b1726">' +
      '<p style="font-size:22px;margin:0 0 12px">You\'re on the list.</p>' +
      '<p>' + BRAND + ' isn\'t live yet. We\'ll email you the moment it launches in New York City.</p>' +
      '<p>Until then: no swiping required.</p>' + site +
      '<p style="font-size:12px;color:#77728a;margin-top:28px">You got this because you joined the ' + BRAND +
      ' waitlist. <a href="' + unsub + '" style="color:#77728a">Unsubscribe</a></p></div>'
  });
}

function markUnsubscribed_(email) {
  var sh = sheet_(SIGNUPS);
  var r = findRow_(sh, SIGNUP_COLS.indexOf('email') + 1, email);
  if (!r) return false;
  sh.getRange(r, SIGNUP_COLS.indexOf('unsubscribed') + 1).setValue('yes');
  return true;
}

function token_(email) {
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret) { secret = Utilities.getUuid(); PropertiesService.getScriptProperties().setProperty('SECRET', secret); }
  var sig = Utilities.computeHmacSha256Signature(email, secret);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '').slice(0, 22);
}

// ---------- helpers ----------
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { setup(); sh = ss.getSheetByName(name); }
  return sh;
}
function safe_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).slice(0, 500);
  // keep spreadsheet formulas from being injected through form fields
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
function findRow_(sh, col, value) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var hit = sh.getRange(2, col, last - 1, 1).createTextFinder(value).matchEntireCell(true).matchCase(false).findNext();
  return hit ? hit.getRow() : 0;
}
function newRefCode_(sh) {
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  var col = SIGNUP_COLS.indexOf('ref_code') + 1;
  for (var tries = 0; tries < 8; tries++) {
    var c = '';
    for (var i = 0; i < 6; i++) c += chars.charAt(Math.floor(Math.random() * chars.length));
    if (!findRow_(sh, col, c)) return c;
  }
  return Utilities.getUuid().slice(0, 8);
}

// ---------- setup + summary ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu(BRAND).addItem('Rebuild Summary tab', 'buildSummary').addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  function ensure(name, cols) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(cols);
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#ece8f7');
    sh.setFrozenRows(1);
    return sh;
  }
  var ev = ensure(EVENTS, EVENT_COLS);
  var sg = ensure(SIGNUPS, SIGNUP_COLS);
  var sp = ensure(SPEND, ['channel', 'utm_content', 'amount_usd', 'note']);
  ev.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  ev.getRange('B:B').setNumberFormat('@');
  sg.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sg.getRange('B:B').setNumberFormat('@');
  sp.getRange('C:C').setNumberFormat('$#,##0.00');
  if (sp.getLastRow() === 1) {
    sp.getRange('E1').setValue('Enter ad spend here. channel must match utm_source exactly (e.g. instagram). ' +
      'Leave utm_content blank for spend on the whole channel, or fill it for one creative.');
  }
  var first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && first.getLastRow() === 0) ss.deleteSheet(first);
  token_('init');
  buildSummary();
}

function buildSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY, 0);
  sh.clear();
  if (sh.getMaxRows() < 1000) sh.insertRowsAfter(sh.getMaxRows(), 1000 - sh.getMaxRows());
  if (sh.getMaxColumns() < 34) sh.insertColumnsAfter(sh.getMaxColumns(), 34 - sh.getMaxColumns());

  // Column letters in Events: A ts, B date, C event, D visitor_id, F channel, J utm_content, L headline_variant, M device, R is_test
  // Column letters in Signups: B date, C email, D channel, H utm_content, J headline_variant, K device, N referred_by, Q top_interest, U is_test
  var NT = 'Events!$R$2:$R,"<>test"';           // exclude test traffic
  var SNT = 'Signups!$U$2:$U,"<>test"';
  function uv(ev, extra) {   // unique visitors with event ev
    return 'COUNTUNIQUEIFS(Events!$D$2:$D,Events!$C$2:$C,"' + ev + '"' + (extra ? ',' + extra : '') + ',' + NT + ')';
  }
  function keys(col) {
    return '=IFERROR(SORT(UNIQUE(FILTER(Events!$' + col + '$2:$' + col + ',Events!$C$2:$C="page_view",Events!$R$2:$R<>"test"))),"")';
  }
  function mapUV(keyRange, ev, evCol) {
    return '=MAP(' + keyRange + ',LAMBDA(k,IF(k="","",' + uv(ev, 'Events!$' + evCol + '$2:$' + evCol + ',k') + ')))';
  }
  function mapSignups(keyRange, sgCol) {
    return '=MAP(' + keyRange + ',LAMBDA(k,IF(k="","",COUNTIFS(Signups!$' + sgCol + '$2:$' + sgCol + ',k,' + SNT + '))))';
  }
  function mapRate(numRange, denRange) {
    return '=MAP(' + numRange + ',' + denRange + ',LAMBDA(n,d,IF(OR(d="",d=0),"",n/d)))';
  }
  function mapCPL(spendRange, signRange) {
    return '=MAP(' + spendRange + ',' + signRange + ',LAMBDA(sp,s,IF(OR(sp="",sp=0),"",IF(s=0,"no sign-ups",sp/s))))';
  }

  sh.getRange('A1').setValue(BRAND + ' waitlist · live summary').setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setValue('Updates automatically. Test traffic (?test=1 or ?internal=1) is excluded. ' +
    'Visitors = unique browsers. Visit → sign-up = sign-ups ÷ visitors.').setFontColor('#6f6a80');

  // Overall funnel
  var overallHead = ['Unique visitors', 'Scrolled 50%', 'Clicked a CTA', 'Held the orb', 'Sign-ups', 'Visit → sign-up',
    'Answered optional Q', 'Shared their link', 'Sign-ups via referral'];
  sh.getRange(4, 1, 1, overallHead.length).setValues([overallHead]);
  sh.getRange(5, 1, 1, overallHead.length).setFormulas([[
    '=' + uv('page_view'),
    '=' + uv('scroll_50'),
    '=' + uv('cta_click'),
    '=' + uv('orb_complete'),
    '=COUNTIFS(Signups!$C$2:$C,"<>",' + SNT + ')',
    '=IF(A5=0,"",E5/A5)',
    '=COUNTIFS(Signups!$Q$2:$Q,"<>",' + SNT + ')',
    '=' + uv('share_click'),
    '=COUNTIFS(Signups!$N$2:$N,"<>",' + SNT + ')'
  ]]);
  sh.getRange('F5').setNumberFormat('0.0%');

  // Table 1: by channel (A–G)
  sh.getRange('A7').setValue('By channel');
  sh.getRange('A8:G8').setValues([['Channel', 'Visitors', 'Clicked CTA', 'Sign-ups', 'Visit → sign-up', 'Spend', 'Cost per sign-up']]);
  sh.getRange('A9').setFormula(keys('F'));
  sh.getRange('B9').setFormula(mapUV('A9:A', 'page_view', 'F'));
  sh.getRange('C9').setFormula(mapUV('A9:A', 'cta_click', 'F'));
  sh.getRange('D9').setFormula(mapSignups('A9:A', 'D'));
  sh.getRange('E9').setFormula(mapRate('D9:D', 'B9:B'));
  sh.getRange('F9').setFormula('=MAP(A9:A,LAMBDA(k,IF(k="","",SUMIFS(Spend!$C$2:$C,Spend!$A$2:$A,k))))');
  sh.getRange('G9').setFormula(mapCPL('F9:F', 'D9:D'));

  // Table 2: by creative (I–P)
  sh.getRange('I7').setValue('By creative (channel × utm_content)');
  sh.getRange('I8:P8').setValues([['Channel', 'Creative', 'Visitors', 'Clicked CTA', 'Sign-ups', 'Visit → sign-up', 'Spend', 'Cost per sign-up']]);
  sh.getRange('I9').setFormula('=IFERROR(SORT(UNIQUE(FILTER({Events!$F$2:$F,Events!$J$2:$J},Events!$C$2:$C="page_view",Events!$R$2:$R<>"test")),1,TRUE,2,TRUE),"")');
  sh.getRange('K9').setFormula('=MAP(I9:I,J9:J,LAMBDA(c,k,IF(c="","",' + uv('page_view', 'Events!$F$2:$F,c,Events!$J$2:$J,k') + ')))');
  sh.getRange('L9').setFormula('=MAP(I9:I,J9:J,LAMBDA(c,k,IF(c="","",' + uv('cta_click', 'Events!$F$2:$F,c,Events!$J$2:$J,k') + ')))');
  sh.getRange('M9').setFormula('=MAP(I9:I,J9:J,LAMBDA(c,k,IF(c="","",COUNTIFS(Signups!$D$2:$D,c,Signups!$H$2:$H,k,' + SNT + '))))');
  sh.getRange('N9').setFormula(mapRate('M9:M', 'K9:K'));
  sh.getRange('O9').setFormula('=MAP(I9:I,J9:J,LAMBDA(c,k,IF(c="","",SUMIFS(Spend!$C$2:$C,Spend!$A$2:$A,c,Spend!$B$2:$B,k))))');
  sh.getRange('P9').setFormula(mapCPL('O9:O', 'M9:M'));

  // Table 3: by headline (R–V)
  sh.getRange('R7').setValue('By headline (A/B test)');
  sh.getRange('R6').setValue(HEADLINE_LEGEND).setFontColor('#6f6a80');
  sh.getRange('R8:V8').setValues([['Headline', 'Visitors', 'Clicked CTA', 'Sign-ups', 'Visit → sign-up']]);
  sh.getRange('R9').setFormula(keys('L'));
  sh.getRange('S9').setFormula(mapUV('R9:R', 'page_view', 'L'));
  sh.getRange('T9').setFormula(mapUV('R9:R', 'cta_click', 'L'));
  sh.getRange('U9').setFormula(mapSignups('R9:R', 'J'));
  sh.getRange('V9').setFormula(mapRate('U9:U', 'S9:S'));

  // Table 4: by day (X–Z)
  sh.getRange('X7').setValue('By day');
  sh.getRange('X8:Z8').setValues([['Date', 'Visitors', 'Sign-ups']]);
  sh.getRange('X9').setFormula(keys('B'));
  sh.getRange('Y9').setFormula(mapUV('X9:X', 'page_view', 'B'));
  sh.getRange('Z9').setFormula(mapSignups('X9:X', 'B'));

  // Table 5: by device (AB–AE)
  sh.getRange('AB7').setValue('By device');
  sh.getRange('AB8:AE8').setValues([['Device', 'Visitors', 'Sign-ups', 'Visit → sign-up']]);
  sh.getRange('AB9').setFormula(keys('M'));
  sh.getRange('AC9').setFormula(mapUV('AB9:AB', 'page_view', 'M'));
  sh.getRange('AD9').setFormula(mapSignups('AB9:AB', 'K'));
  sh.getRange('AE9').setFormula(mapRate('AD9:AD', 'AC9:AC'));

  // Formatting
  sh.getRange('A4:I4').setFontWeight('bold').setBackground('#ece8f7');
  ['A7', 'I7', 'R7', 'X7', 'AB7'].forEach(function (a) { sh.getRange(a).setFontWeight('bold').setFontSize(12); });
  ['A8:G8', 'I8:P8', 'R8:V8', 'X8:Z8', 'AB8:AE8'].forEach(function (a) { sh.getRange(a).setFontWeight('bold').setBackground('#ece8f7'); });
  ['E9:E', 'N9:N', 'V9:V', 'AE9:AE'].forEach(function (a) { sh.getRange(a).setNumberFormat('0.0%'); });
  ['F9:G', 'O9:P'].forEach(function (a) { sh.getRange(a).setNumberFormat('$#,##0.00'); });
  sh.setFrozenRows(8);
  sh.setColumnWidths(1, 31, 110);
  sh.setColumnWidth(1, 170); sh.setColumnWidth(9, 130); sh.setColumnWidth(10, 150);
  [8, 17, 23, 27].forEach(function (c) { sh.setColumnWidth(c, 24); });
  ss.setActiveSheet(sh);
}
