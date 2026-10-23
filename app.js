/* vibe waitlist: attribution, funnel events, sign-up, success dialog, hold-to-open orb. */
(function () {
  'use strict';

  var C = window.VIBE_CONFIG || {};
  var ENDPOINT = (C.ENDPOINT || '').trim();

  /* ---------- safe storage ---------- */
  function store(kind) {
    return {
      get: function (k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { window[kind].setItem(k, v); } catch (e) {} },
      del: function (k) { try { window[kind].removeItem(k); } catch (e) {} }
    };
  }
  var LS = store('localStorage');
  var SS = store('sessionStorage');

  function rid(n) {
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789', out = '', arr;
    try { arr = crypto.getRandomValues(new Uint32Array(n)); } catch (e) { arr = null; }
    for (var i = 0; i < n; i++) out += chars[(arr ? arr[i] : Math.floor(Math.random() * 4e9)) % chars.length];
    return out;
  }

  var params = new URLSearchParams(location.search);

  /* ---------- test / internal traffic (excluded from the Summary) ---------- */
  if (params.get('internal') === '1') LS.set('vibe_internal', '1');
  if (params.get('internal') === '0') LS.del('vibe_internal');
  if (params.get('test') === '1') SS.set('vibe_test', '1');
  var isTest = SS.get('vibe_test') === '1' || LS.get('vibe_internal') === '1' ||
    location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  /* ---------- attribution ---------- */
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  function clean(v) {
    return (v || '').toString().trim().toLowerCase()
      .replace(/\s+/g, '_').replace(/[^a-z0-9_.\-]/g, '').slice(0, 80);
  }
  var hasUtm = UTM.some(function (k) { return clean(params.get(k)); });
  var attr = null;
  if (hasUtm) {
    attr = {};
    UTM.forEach(function (k) { attr[k] = clean(params.get(k)) || '(none)'; });
    attr.landing_url = location.href.slice(0, 500);
    LS.set('vibe_attr', JSON.stringify(attr));   // remember the last campaign that brought this visitor
  } else {
    try { attr = JSON.parse(LS.get('vibe_attr') || 'null'); } catch (e) { attr = null; }
  }
  if (!attr) {
    attr = {};
    UTM.forEach(function (k) { attr[k] = '(none)'; });
    attr.landing_url = location.href.slice(0, 500);
  }

  var ua = navigator.userAgent || '';
  var inApp = /Instagram/i.test(ua) ? 'instagram'
    : /musical_ly|BytedanceWebview|TikTok/i.test(ua) ? 'tiktok'
    : /FBAN|FBAV|FB_IAB/i.test(ua) ? 'facebook'
    : /LinkedInApp/i.test(ua) ? 'linkedin'
    : /Snapchat/i.test(ua) ? 'snapchat' : '';
  var device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone|iPod/i.test(ua) ? 'mobile' : 'desktop';

  var referrer = document.referrer || '';
  var refHost = '';
  try { refHost = referrer ? new URL(referrer).hostname.replace(/^www\./, '') : ''; } catch (e) {}
  if (refHost === location.hostname) refHost = '';
  function hostToChannel(h) {
    if (!h) return '';
    var map = [['instagram', 'instagram'], ['tiktok', 'tiktok'], ['facebook', 'facebook'], ['fb.', 'facebook'],
      ['reddit', 'reddit'], ['t.co', 'x'], ['twitter', 'x'], ['x.com', 'x'], ['linkedin', 'linkedin'],
      ['google', 'google'], ['bing', 'bing'], ['youtube', 'youtube'], ['xiaohongshu', 'xiaohongshu'], ['xhslink', 'xiaohongshu']];
    for (var i = 0; i < map.length; i++) if (h.indexOf(map[i][0]) > -1) return map[i][1];
    return h;
  }
  // channel = utm_source when the link was tagged; otherwise a best guess, marked with "~"
  var channel = attr.utm_source !== '(none)' ? attr.utm_source
    : params.get('ttclid') ? '~tiktok'
    : params.get('fbclid') ? '~facebook_or_instagram'
    : inApp ? '~' + inApp
    : refHost ? '~' + hostToChannel(refHost)
    : '(direct)';

  var ref = clean(params.get('ref'));
  if (ref) LS.set('vibe_ref', ref);

  /* ---------- headline A/B ---------- */
  var HEAD = C.HEADLINES || { a: 'A spark. That feels like you.' };
  var active = (C.ACTIVE_VARIANTS || Object.keys(HEAD)).filter(function (v) { return HEAD[v]; });
  if (!active.length) active = ['a'];
  var forced = (params.get('v') || '').toLowerCase();
  var saved = LS.get('vibe_variant');
  var variant = active.indexOf(forced) > -1 ? forced
    : active.indexOf(saved) > -1 ? saved
    : active[Math.floor(Math.random() * active.length)];
  LS.set('vibe_variant', variant);
  var h1 = document.getElementById('headline');
  if (h1 && HEAD[variant]) h1.textContent = HEAD[variant];

  /* ---------- ids ---------- */
  var vid = LS.get('vibe_vid');
  if (!vid) { vid = rid(12); LS.set('vibe_vid', vid); }
  var sid = SS.get('vibe_sid');
  if (!sid) { sid = rid(10); SS.set('vibe_sid', sid); }

  function base() {
    return {
      visitor_id: vid,
      session_id: sid,
      channel: channel,
      utm_source: attr.utm_source,
      utm_medium: attr.utm_medium,
      utm_campaign: attr.utm_campaign,
      utm_content: attr.utm_content,
      utm_term: attr.utm_term,
      headline_variant: variant,
      device: device,
      in_app: inApp,
      referrer: referrer.slice(0, 300),
      page_url: location.href.slice(0, 500),
      landing_url: attr.landing_url,
      referred_by: LS.get('vibe_ref') || '',
      is_test: isTest ? 'test' : '',
      client_time: new Date().toISOString()
    };
  }

  /* ---------- sending ---------- */
  function post(obj, readable) {
    var body = JSON.stringify(obj);
    if (!ENDPOINT) {
      if (window.console) console.info('[vibe] ENDPOINT not set; would send:', obj);
      return Promise.reject(new Error('no_endpoint'));
    }
    if (readable) {
      // text/plain body keeps this a "simple" request, so no CORS preflight
      return fetch(ENDPOINT, { method: 'POST', body: body, credentials: 'omit', redirect: 'follow' })
        .then(function (r) { return r.json(); });
    }
    return fetch(ENDPOINT, { method: 'POST', body: body, mode: 'no-cors', credentials: 'omit', keepalive: true })
      .catch(function () {});
  }
  function track(event, detail) {
    var o = base();
    o.type = 'event';
    o.event = event;
    o.detail = detail || '';
    post(o, false).catch(function () {});
  }

  /* ---------- ad pixels (optional) ---------- */
  if (C.META_PIXEL_ID) {
    /* eslint-disable */
    !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', C.META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }
  if (C.TIKTOK_PIXEL_ID) {
    /* eslint-disable */
    !function (w, d, t) { w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || []; ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"], ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } }; for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]); ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e }, ttq.load = function (e, n) { var i = "https://analytics.tiktok.com/i18n/pixel/events.js"; ttq._i = ttq._i || {}, ttq._i[e] = [], ttq._i[e]._u = i, ttq._t = ttq._t || {}, ttq._t[e] = +new Date, ttq._o = ttq._o || {}, ttq._o[e] = n || {}; var o = document.createElement("script"); o.type = "text/javascript", o.async = !0, o.src = i + "?sdkid=" + e + "&lib=" + t; var a = document.getElementsByTagName("script")[0]; a.parentNode.insertBefore(o, a) }; }(window, document, 'ttq');
    /* eslint-enable */
    window.ttq.load(C.TIKTOK_PIXEL_ID);
    window.ttq.page();
  }
  function firePixels() {
    try { if (window.fbq) window.fbq('track', 'Lead'); } catch (e) {}
    try { if (window.ttq) window.ttq.track('CompleteRegistration'); } catch (e) {}
  }

  /* ---------- page view, scroll depth, nav state ---------- */
  track('page_view', '');
  var nav = document.querySelector('.nav');
  var scrolled50 = false;
  function onScroll() {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
    if (!scrolled50) {
      var doc = document.documentElement;
      var depth = (window.scrollY + window.innerHeight) / Math.max(doc.scrollHeight, 1);
      if (depth >= 0.5) { scrolled50 = true; track('scroll_50', ''); }
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- nav CTA: bring the visitor to the hero form ---------- */
  var heroForm = document.getElementById('join');
  function highlightHeroForm() {
    if (!heroForm) return;
    heroForm.classList.remove('attention');
    void heroForm.offsetWidth;
    heroForm.classList.add('attention');
    var input = heroForm.querySelector('input[type=email]');
    if (input && device === 'desktop') { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
  }
  document.querySelectorAll('a[data-cta]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      track('cta_click', a.getAttribute('data-cta'));
      if (heroForm) {
        e.preventDefault();
        heroForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(highlightHeroForm, 350);
      }
    });
  });

  /* ---------- sign-up ---------- */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var refCode = LS.get('vibe_ref_code') || '';
  var joinedEmail = LS.get('vibe_joined') || '';

  function setMsg(form, text, isErr) {
    var m = form.querySelector('.form-msg');
    if (!m) return;
    m.textContent = text || '';
    m.classList.toggle('err', !!isErr);
  }

  document.querySelectorAll('form.join').forEach(function (form) {
    var where = form.getAttribute('data-form') || 'form';
    var input = form.querySelector('input[type=email]');
    var btn = form.querySelector('button[type=submit]');
    var label = btn ? btn.textContent : '';

    input.addEventListener('input', function () {
      input.removeAttribute('aria-invalid');
      setMsg(form, '');
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      track('cta_click', where);
      var hp = form.querySelector('input[name=company]');
      var email = (input.value || '').trim().toLowerCase();

      if (!EMAIL_RE.test(email)) {
        input.setAttribute('aria-invalid', 'true');
        setMsg(form, 'Enter an email address like name@example.com.', true);
        input.focus();
        return;
      }
      if (joinedEmail && joinedEmail === email) {
        setMsg(form, "You're already on the list.");
        return;
      }
      if (!ENDPOINT) {
        setMsg(form, "Sign-ups aren't connected yet. Please check back soon.", true);
        if (window.console) console.warn('[vibe] Set ENDPOINT in config.js to accept sign-ups.');
        return;
      }

      var o = base();
      o.type = 'signup';
      o.email = email;
      o.form_location = where;
      o.company = hp ? hp.value : '';

      btn.disabled = true;
      btn.textContent = 'Joining…';

      post(o, true)
        .then(function (res) {
          if (res && res.status === 'ok') return success(email, res.ref_code, form);
          if (res && res.status === 'duplicate') {
            LS.set('vibe_joined', email);
            joinedEmail = email;
            setMsg(form, "You're already on the list.");
            return;
          }
          if (res && res.error === 'invalid_email') {
            input.setAttribute('aria-invalid', 'true');
            setMsg(form, 'That email address looks incomplete. Check it and try again.', true);
            return;
          }
          var se = new Error((res && res.error) || 'bad_response');
          se.server = true;
          throw se;
        })
        .catch(function (err) {
          if (err && err.message === 'no_endpoint') return;
          if (err && err.server) {
            setMsg(form, "We couldn't save that just now. Please try again in a minute.", true);
            if (window.console) console.warn('[vibe] server error:', err.message);
            return;
          }
          // Network-level failure: the reply may be unreadable even though the row was saved.
          // Send once more without reading the reply; the server ignores duplicates.
          if (window.console) console.warn('[vibe] sign-up reply unreadable, retrying blind:', err);
          return fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(o), mode: 'no-cors', credentials: 'omit' })
            .then(function () { success(email, '', form); })
            .catch(function () {
              setMsg(form, "We couldn't save that. Check your connection and try again.", true);
            });
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = label;
        });
    });
  });

  /* ---------- success dialog ---------- */
  var dlg = document.getElementById('joined');
  var survey = document.getElementById('survey');
  var share = document.getElementById('share');
  var shareInput = document.getElementById('share-link');

  function openDialog() {
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') { try { dlg.showModal(); return; } catch (e) {} }
    dlg.setAttribute('open', '');
  }
  function closeDialog() {
    if (!dlg) return;
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }
  function shareUrl() {
    var root = (C.SITE_URL || (location.origin + location.pathname)).replace(/[?#].*$/, '');
    var q = 'utm_source=referral&utm_medium=word_of_mouth&utm_campaign=referral';
    return root + '?' + (refCode ? 'ref=' + encodeURIComponent(refCode) + '&' : '') + q;
  }
  function showShare(thanks) {
    survey.hidden = true;
    share.hidden = false;
    share.querySelector('[data-thanks]').hidden = !thanks;
    shareInput.value = shareUrl();
    var ns = share.querySelector('[data-native-share]');
    if (ns) ns.hidden = typeof navigator.share !== 'function';
  }

  function success(email, code, form) {
    LS.set('vibe_joined', email);
    joinedEmail = email;
    if (code) { refCode = code; LS.set('vibe_ref_code', code); }
    var input = form.querySelector('input[type=email]');
    if (input) input.value = '';
    setMsg(form, "You're on the list.");
    firePixels();
    survey.hidden = false;
    share.hidden = true;
    survey.reset();
    openDialog();
  }

  if (survey) {
    survey.addEventListener('submit', function (e) {
      e.preventDefault();
      var city = survey.querySelector('#city').value;
      var pick = survey.querySelector('input[name=top_interest]:checked');
      var interest = pick ? pick.value : '';
      if (city || interest) {
        var o = base();
        o.type = 'survey';
        o.email = joinedEmail;
        o.city = city;
        o.top_interest = interest;
        post(o, false).catch(function () {});
      }
      showShare(!!(city || interest));
    });
    survey.querySelector('[data-skip]').addEventListener('click', function () { showShare(false); });
  }

  if (dlg) {
    dlg.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closeDialog); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) closeDialog(); });
  }

  var copyBtn = document.querySelector('[data-copy]');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var url = shareInput.value;
      track('share_click', 'copy');
      function done() { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1800); }
      function fallback() { shareInput.focus(); shareInput.select(); try { document.execCommand('copy'); done(); } catch (e) {} }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, fallback);
      } else { fallback(); }
    });
  }
  var nativeShare = document.querySelector('[data-native-share]');
  if (nativeShare) {
    nativeShare.addEventListener('click', function () {
      track('share_click', 'native');
      navigator.share({ title: 'vibe', text: 'A social app with no swiping. Small dinners with people who share your vibe.', url: shareInput.value })
        .catch(function () {});
    });
  }

  /* ---------- waitlist count (shown only past the threshold) ---------- */
  var countEl = document.querySelector('[data-count]');
  var threshold = Number(C.COUNT_THRESHOLD || 0);
  if (ENDPOINT && countEl && threshold > 0) {
    fetch(ENDPOINT + (ENDPOINT.indexOf('?') > -1 ? '&' : '?') + 'action=count', { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.count >= threshold) {
          countEl.textContent = 'Join ' + Number(d.count).toLocaleString('en-US') + ' people already on the list';
          countEl.hidden = false;
        }
      })
      .catch(function () {});
  }

  /* ---------- footer social links ---------- */
  var social = C.SOCIAL || {};
  document.querySelectorAll('[data-social]').forEach(function (a) {
    var url = social[a.getAttribute('data-social')];
    if (url) { a.href = url; a.hidden = false; a.target = '_blank'; a.rel = 'noopener'; }
  });

  /* ---------- hold-to-open orb ---------- */
  var orb = document.querySelector('[data-orb]');
  var ring = document.querySelector('.ring-fg');
  var orbScreen = document.querySelector('[data-orb-screen]');
  var homeScreen = document.querySelector('[data-home-screen]');
  var resetBtn = document.querySelector('[data-orb-reset]');
  if (orb && ring) {
    var CIRC = 351.86, HOLD_MS = 1300;
    var progress = 0, holding = false, last = 0, raf = 0, completed = false;
    function draw() { ring.style.strokeDashoffset = String(CIRC * (1 - progress)); }
    function tick(t) {
      var dt = last ? t - last : 16;
      last = t;
      progress += (holding ? 1 : -2.2) * dt / HOLD_MS;
      if (progress >= 1) { progress = 1; draw(); return complete(); }
      if (progress <= 0) { progress = 0; draw(); raf = 0; last = 0; return; }
      draw();
      raf = requestAnimationFrame(tick);
    }
    function start(e) {
      if (completed) return;
      if (e && e.type === 'pointerdown') { try { orb.setPointerCapture(e.pointerId); } catch (err) {} }
      holding = true;
      orb.classList.add('holding');
      if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
    }
    function stop() {
      holding = false;
      orb.classList.remove('holding');
      if (!raf && progress > 0 && !completed) { last = 0; raf = requestAnimationFrame(tick); }
    }
    function complete() {
      raf = 0; last = 0; holding = false; completed = true;
      orb.classList.remove('holding');
      track('orb_complete', '');
      setTimeout(function () {
        orbScreen.hidden = true;
        homeScreen.hidden = false;
        if (device === 'desktop') highlightHeroForm();
        else if (heroForm) heroForm.classList.add('attention');
      }, 220);
    }
    orb.addEventListener('pointerdown', start);
    orb.addEventListener('pointerup', stop);
    orb.addEventListener('pointercancel', stop);
    orb.addEventListener('lostpointercapture', stop);
    orb.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    orb.addEventListener('keydown', function (e) {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start(); }
    });
    orb.addEventListener('keyup', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stop(); }
    });
    if (resetBtn) resetBtn.addEventListener('click', function () {
      completed = false; progress = 0; draw();
      homeScreen.hidden = true;
      orbScreen.hidden = false;
      if (heroForm) heroForm.classList.remove('attention');
    });
  }
})();
