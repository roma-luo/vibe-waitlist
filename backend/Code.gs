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
  'detail', 'is_test', 'owner'];
var SIGNUP_COLS = ['signup_time', 'date', 'email', 'channel', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'utm_term', 'headline_variant', 'device', 'in_app', 'referrer', 'referred_by', 'ref_code',
  'city', 'top_interest', 'visitor_id', 'landing_url', 'form_location', 'is_test', 'unsubscribed', 'owner'];
var SPEND_COLS = ['member', 'channel', 'utm_content', 'amount_usd', 'note'];
// Team member codes (the m= value in links). Neutral codes only, never names.
var MEMBERS = ['m1', 'm2', 'm3', 'm4', 'team', '(none)'];
var ALLOWED_EVENTS = { page_view: 1, scroll_50: 1, cta_click: 1, orb_complete: 1, share_click: 1, signup: 1, survey: 1 };
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- web app ----------
function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ status: 'error', error: 'bad_json' }); }
  data.owner = String(data.owner || '').toLowerCase().replace(/[^a-z0-9_.\-()]/g, '').slice(0, 20) || '(none)';
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
      'device', 'in_app', 'referrer', 'referred_by', 'visitor_id', 'landing_url', 'form_location', 'is_test', 'owner']
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

/** Creates the tabs, or upgrades them in place when columns were added. Safe to run again. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  function ensure(name, cols) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#ece8f7');
    sh.setFrozenRows(1);
    return sh;
  }
  var ev = ensure(EVENTS, EVENT_COLS);
  var sg = ensure(SIGNUPS, SIGNUP_COLS);

  // Spend: older versions had no "member" column first; shift existing rows right instead of losing them.
  var sp = ss.getSheetByName(SPEND);
  if (sp && sp.getRange('A1').getValue() === 'channel') {
    sp.insertColumnBefore(1);
    sp.getRange('F1:G1').clearContent();
  }
  sp = ensure(SPEND, SPEND_COLS);
  sp.getRange('G1').setValue('Enter ad spend here, one row per member and channel (or per creative). ' +
    'member = m1…m4 or team. channel must match utm_source exactly (e.g. instagram). ' +
    'Leave utm_content blank for spend on the whole channel.');

  ev.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  ev.getRange('B:B').setNumberFormat('@');
  sg.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sg.getRange('B:B').setNumberFormat('@');
  sp.getRange('D:D').setNumberFormat('$#,##0.00');

  var first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && first.getLastRow() === 0) ss.deleteSheet(first);
  token_('init');
  buildSummary();
}

function colL_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Summary tab. Cell B3 picks a member; every table except "By member" follows it.
 * Events columns: B date, C event, D visitor_id, F channel, J utm_content, L headline_variant, M device, R is_test, S owner
 * Signups columns: B date, C email, D channel, H utm_content, J headline_variant, K device, N referred_by, Q top_interest, U is_test, W owner
 * Spend columns: A member, B channel, C utm_content, D amount_usd
 */
function buildSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY, 0);
  var prevSel = String(sh.getRange('B3').getValue() || 'All');
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  if (sh.getMaxRows() < 1000) sh.insertRowsAfter(sh.getMaxRows(), 1000 - sh.getMaxRows());
  if (sh.getMaxColumns() < 42) sh.insertColumnsAfter(sh.getMaxColumns(), 42 - sh.getMaxColumns());

  var SEL = '$B$3';
  var MC = 'IF(' + SEL + '="All","<>#all#",' + SEL + ')';           // member criterion for *IFS functions
  function evCrit(mf) { return 'Events!$R$2:$R,"<>test"' + (mf ? ',Events!$S$2:$S,' + MC : ''); }
  function sgCrit(mf) { return 'Signups!$U$2:$U,"<>test"' + (mf ? ',Signups!$W$2:$W,' + MC : ''); }
  function spCrit(mf) { return mf ? ',Spend!$A$2:$A,' + MC : ''; }
  function filt(mf) {
    return 'Events!$C$2:$C="page_view",Events!$R$2:$R<>"test"' +
      (mf ? ',(' + SEL + '="All")+(Events!$S$2:$S=' + SEL + ')' : '');
  }
  function uv(ev, extra, mf) {
    return 'COUNTUNIQUEIFS(Events!$D$2:$D,Events!$C$2:$C,"' + ev + '"' + (extra ? ',' + extra : '') + ',' + evCrit(mf) + ')';
  }

  // Title, member picker, overall funnel
  sh.getRange('A1').setValue(BRAND + ' waitlist · live summary').setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setValue('Updates automatically. Test traffic (?test=1 or ?internal=1) is excluded. ' +
    'Visitors = unique browsers. Visit → sign-up = sign-ups ÷ visitors.').setFontColor('#6f6a80');
  sh.getRange('A3').setValue('Show member:').setFontWeight('bold').setHorizontalAlignment('right');
  var choices = ['All'].concat(MEMBERS);
  sh.getRange('B3').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(choices, true).setAllowInvalid(false).build())
    .setValue(choices.indexOf(prevSel) > -1 ? prevSel : 'All')
    .setBackground('#fff4c2').setFontWeight('bold');
  sh.getRange('C3').setValue('← pick a code to see one person\'s numbers. "By member" always shows everyone.').setFontColor('#6f6a80');

  var overallHead = ['Unique visitors', 'Scrolled 50%', 'Clicked a CTA', 'Held the orb', 'Sign-ups', 'Visit → sign-up',
    'Answered optional Q', 'Shared their link', 'Sign-ups via referral'];
  sh.getRange(5, 1, 1, overallHead.length).setValues([overallHead]).setFontWeight('bold').setBackground('#ece8f7');
  sh.getRange(6, 1, 1, overallHead.length).setFormulas([[
    '=' + uv('page_view', '', true),
    '=' + uv('scroll_50', '', true),
    '=' + uv('cta_click', '', true),
    '=' + uv('orb_complete', '', true),
    '=COUNTIFS(Signups!$C$2:$C,"<>",' + sgCrit(true) + ')',
    '=IF(A6=0,"",E6/A6)',
    '=COUNTIFS(Signups!$Q$2:$Q,"<>",' + sgCrit(true) + ')',
    '=' + uv('share_click', '', true),
    '=COUNTIFS(Signups!$N$2:$N,"<>",' + sgCrit(true) + ')'
  ]]);
  sh.getRange('F6').setNumberFormat('0.0%');

  // Breakdown tables, placed left to right from column A, row 9
  var HEAD = { vis: 'Visitors', cta: 'Clicked CTA', sign: 'Sign-ups', conv: 'Visit → sign-up', spend: 'Spend', cpl: 'Cost per sign-up' };
  var KEY_ROW = 10, col = 1;
  function table(title, keys, mf, metrics) {
    var c0 = col, nk = keys.length;
    var keyRanges = [], params = [];
    for (var i = 0; i < nk; i++) {
      var L = colL_(c0 + i);
      keyRanges.push(L + KEY_ROW + ':' + L);
      params.push('k' + (i + 1));
    }
    var evMatch = keys.map(function (k, i) { return 'Events!$' + k.ev + '$2:$' + k.ev + ',k' + (i + 1); }).join(',');
    var sgMatch = keys.map(function (k, i) { return 'Signups!$' + k.sg + '$2:$' + k.sg + ',k' + (i + 1); }).join(',');
    var spMatch = keys.every(function (k) { return k.sp; })
      ? keys.map(function (k, i) { return 'Spend!$' + k.sp + '$2:$' + k.sp + ',k' + (i + 1); }).join(',') : '';
    function lam(expr) {
      return '=MAP(' + keyRanges.join(',') + ',LAMBDA(' + params.join(',') + ',IF(k1="","",' + expr + ')))';
    }
    var src = keys.map(function (k) { return 'Events!$' + k.ev + '$2:$' + k.ev; });
    var keyF = nk === 1
      ? '=IFERROR(SORT(UNIQUE(FILTER(' + src[0] + ',' + filt(mf) + '))),"")'
      : '=IFERROR(SORT(UNIQUE(FILTER({' + src.join(',') + '},' + filt(mf) + ')),1,TRUE,2,TRUE),"")';

    var headers = keys.map(function (k) { return k.label; });
    var where = {};
    var c = c0 + nk;
    metrics.forEach(function (m) { where[m] = colL_(c); headers.push(HEAD[m]); c++; });

    sh.getRange(KEY_ROW - 2, c0).setValue(title).setFontWeight('bold').setFontSize(12);
    sh.getRange(KEY_ROW - 1, c0, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#ece8f7');
    sh.getRange(KEY_ROW, c0).setFormula(keyF);
    metrics.forEach(function (m) {
      var cell = sh.getRange(where[m] + KEY_ROW), rng = function (x) { return where[x] + KEY_ROW + ':' + where[x]; };
      if (m === 'vis') cell.setFormula(lam(uv('page_view', evMatch, mf)));
      if (m === 'cta') cell.setFormula(lam(uv('cta_click', evMatch, mf)));
      if (m === 'sign') cell.setFormula(lam('COUNTIFS(' + sgMatch + ',' + sgCrit(mf) + ')'));
      if (m === 'conv') cell.setFormula('=MAP(' + rng('sign') + ',' + rng('vis') + ',LAMBDA(n,d,IF(OR(d="",d=0),"",n/d)))');
      if (m === 'spend') cell.setFormula(lam('SUMIFS(Spend!$D$2:$D,' + spMatch + spCrit(mf) + ')'));
      if (m === 'cpl') cell.setFormula('=MAP(' + rng('spend') + ',' + rng('sign') + ',LAMBDA(sp,s,IF(OR(sp="",sp=0),"",IF(s=0,"no sign-ups",sp/s))))');
      if (m === 'conv') sh.getRange(rng('conv')).setNumberFormat('0.0%');
      if (m === 'spend' || m === 'cpl') sh.getRange(rng(m)).setNumberFormat('$#,##0.00');
    });
    sh.setColumnWidth(c0, 150);
    sh.setColumnWidth(c, 24);   // gap column
    col = c + 1;
    return c0;
  }

  var ALL = ['vis', 'cta', 'sign', 'conv', 'spend', 'cpl'];
  table('By member (everyone)', [{ ev: 'S', sg: 'W', sp: 'A', label: 'Member' }], false, ALL);
  table('By channel', [{ ev: 'F', sg: 'D', sp: 'B', label: 'Channel' }], true, ALL);
  table('By creative (channel × utm_content)',
    [{ ev: 'F', sg: 'D', sp: 'B', label: 'Channel' }, { ev: 'J', sg: 'H', sp: 'C', label: 'Creative' }], true, ALL);
  var hc = table('By headline (A/B test)', [{ ev: 'L', sg: 'J', label: 'Headline' }], true, ['vis', 'cta', 'sign', 'conv']);
  sh.getRange(KEY_ROW - 3, hc).setValue(HEADLINE_LEGEND).setFontColor('#6f6a80');
  table('By day', [{ ev: 'B', sg: 'B', label: 'Date' }], true, ['vis', 'sign']);
  table('By device', [{ ev: 'M', sg: 'K', label: 'Device' }], true, ['vis', 'sign', 'conv']);

  sh.setFrozenRows(KEY_ROW - 1);
  ss.setActiveSheet(sh);
}
