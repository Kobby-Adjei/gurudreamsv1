/* AirBridge landing: headline/price test assignment and the waitlist form. No cookies, no third parties. */
(function () {
  'use strict';

  var HEADLINES = {
    private: 'Drop a task to any of your AI agents.',
    cross: 'Pass a task from Claude Code to Codex.',
    bridge: 'Stop copy-pasting between your AI agents.',
    current: 'Your AI agents, one drop away.'
  };
  var VARIANTS = ['private', 'cross', 'bridge', 'current'];
  var PRICES = ['8', '15'];

  function get(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { window[store].setItem(k, v); } catch (e) { /* storage blocked */ } }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  var params = new URLSearchParams(location.search);

  // URL wins; otherwise the visitor keeps the arm they were first given.
  function assign(param, key, allowed) {
    var v = params.get(param);
    if (allowed.indexOf(v) === -1) v = get('localStorage', key);
    if (allowed.indexOf(v) === -1) v = pick(allowed);
    set('localStorage', key, v);
    return v;
  }

  var variant = assign('v', 'ab_variant', VARIANTS);
  var price = assign('p', 'ab_price', PRICES);

  document.getElementById('headline').textContent = HEADLINES[variant];
  document.getElementById('price').textContent = 'Early access price: $' + price + '/month';
  document.documentElement.setAttribute('data-variant', variant);

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store'
    });
  }

  // One view per tab session: the denominator for the conversion rate.
  if (!get('sessionStorage', 'ab_viewed')) {
    set('sessionStorage', 'ab_viewed', '1');
    post('/v1/waitlist/view', { variant: variant, price: Number(price) }).catch(function () {});
  }

  var form = document.getElementById('waitlist');
  var email = document.getElementById('email');
  var company = document.getElementById('company');
  var button = document.getElementById('submit');
  var msg = document.getElementById('form-msg');
  var done = document.getElementById('done');

  function referrerOrigin() {
    try { return document.referrer ? new URL(document.referrer).origin : null; } catch (e) { return null; }
  }
  function utm(name) {
    var v = params.get(name);
    return v ? v.slice(0, 64) : null;
  }
  function valid(v) {
    return v.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v) && /\.[a-z][a-z0-9-]*[a-z0-9]$/i.test(v);
  }
  function showError(text) {
    msg.textContent = text;
    email.setAttribute('aria-invalid', 'true');
  }
  function showDone() {
    form.hidden = true;
    done.hidden = false;
    done.focus();
    try { history.replaceState(null, '', location.pathname + location.search + '#thanks'); } catch (e) { /* ignore */ }
  }

  email.addEventListener('input', function () {
    if (msg.textContent) { msg.textContent = ''; email.removeAttribute('aria-invalid'); }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (button.disabled) return;
    var value = email.value.trim();
    if (!valid(value)) {
      showError('Enter a valid email address.');
      email.focus();
      return;
    }
    button.disabled = true;
    button.textContent = 'Sending…';
    msg.textContent = '';
    post('/v1/waitlist', {
      email: value,
      variant: variant,
      price: Number(price),
      referrer: referrerOrigin(),
      utm_source: utm('utm_source'),
      utm_medium: utm('utm_medium'),
      utm_campaign: utm('utm_campaign'),
      company: company.value
    }).then(function (res) {
      if (res.ok) return showDone();
      if (res.status === 400) showError('That email doesn’t look right.');
      else if (res.status === 429) showError('Too many tries. Wait a minute and try again.');
      else showError('Something went wrong. Please try again.');
    }).catch(function () {
      showError('Couldn’t reach the server. Check your connection and try again.');
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Join the list';
    });
  });

  // Preview the success state directly (also what the page shows after signing up).
  if (location.hash === '#thanks') { form.hidden = true; done.hidden = false; }
})();
