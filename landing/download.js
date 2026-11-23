/* AirBridge landing: the download button. Reads /downloads/latest.json (published by CI) and offers the build for
 * this computer: Mac (Apple Silicon by default, Intel when the browser says so) or Windows. Other builds stay one
 * click away. Phones and other systems get every link plus the email option. No third parties, no cookies. */
(function () {
  'use strict';

  var get = document.getElementById('get');
  if (!get) return;
  var main = document.getElementById('dl-main');
  var label = document.getElementById('dl-label');
  var meta = document.getElementById('dl-meta');
  var other = document.getElementById('dl-other');
  var note = document.getElementById('dl-note');
  var emailLabel = document.getElementById('email-label');
  var cta = document.getElementById('cta');
  var toggle = document.getElementById('updates-toggle');
  var root = document.documentElement;
  root.setAttribute('data-downloads', 'loading');

  // With a download button the email form folds behind "Get updates by email"; otherwise it stays open.
  function fold(open) {
    cta.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', function () {
    var open = cta.hidden;
    fold(open);
    if (open) document.getElementById('email').focus();
  });

  var NAMES = { 'mac-arm64': 'Mac with Apple silicon', 'mac-x64': 'Mac with Intel', 'win-x64': 'Windows' };
  var SAFE_URL = /^\/downloads\/[0-9A-Za-z.-]+\/AirBridge-Pro-[0-9A-Za-z.-]+\.(dmg|exe)$/;
  var NOTES = {
    mac: 'First open on a Mac: System Settings → Privacy & Security → Open Anyway.',
    win: 'First open on Windows: More info → Run anyway.'
  };

  var nav = window.navigator || {};
  var ua = nav.userAgent || '';
  var uad = nav.userAgentData || null;
  var touchMac = /Macintosh/.test(ua) && nav.maxTouchPoints > 1; // iPadOS asks for the desktop site
  var phone = touchMac || /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (uad && uad.mobile);
  var plat = uad && uad.platform ? uad.platform : '';
  var os = phone ? 'phone'
    : (/^macOS$/i.test(plat) || /Macintosh|Mac OS X/.test(ua)) ? 'mac'
    : (/^Windows$/i.test(plat) || /Windows NT/.test(ua)) ? 'win'
    : 'other';

  function mb(bytes) {
    var n = bytes / 1048576;
    return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' MB';
  }

  function link(f, text) {
    var a = document.createElement('a');
    a.href = f.url;
    a.textContent = text;
    a.setAttribute('aria-label', 'Download for ' + NAMES[f.key] + ', ' + mb(f.size));
    return a;
  }

  function soonState() {
    get.setAttribute('data-state', 'soon');
    emailLabel.textContent = 'Get an email when it’s ready';
    root.setAttribute('data-downloads', 'soon');
    fold(true);
  }

  // Intel or Apple silicon? Chromium says so through client hints; elsewhere the default (Apple silicon) stands and
  // the Intel build is the first link under the button.
  function macArch() {
    if (!uad || !uad.getHighEntropyValues) return Promise.resolve('arm64');
    return uad.getHighEntropyValues(['architecture']).then(function (h) {
      return h && h.architecture === 'x86' ? 'x64' : 'arm64';
    }, function () { return 'arm64'; });
  }

  function render(m, arch) {
    var byKey = {};
    (m.files || []).forEach(function (f) {
      if (!f || typeof f.url !== 'string' || !SAFE_URL.test(f.url)) return;
      var key = f.platform + '-' + f.arch;
      if (!NAMES[key] || typeof f.size !== 'number') return;
      byKey[key] = { key: key, url: f.url, size: f.size };
    });
    var version = typeof m.version === 'string' && /^[0-9A-Za-z.-]{1,40}$/.test(m.version) ? m.version : '';
    var keys = ['mac-arm64', 'mac-x64', 'win-x64'].filter(function (k) { return byKey[k]; });
    if (!keys.length) return soonState();

    var primary = os === 'mac' ? (byKey['mac-' + arch] ? 'mac-' + arch : byKey['mac-arm64'] ? 'mac-arm64' : 'mac-x64')
      : os === 'win' ? 'win-x64' : null;
    if (primary && !byKey[primary]) primary = null;

    get.setAttribute('data-state', primary ? 'ready' : 'list');
    root.setAttribute('data-downloads', primary ? 'ready' : 'list');
    fold(!primary);
    toggle.parentNode.hidden = !primary;
    var bits = [];
    if (version) bits.push('Version ' + version);

    if (primary) {
      var f = byKey[primary];
      main.href = f.url;
      label.textContent = primary === 'win-x64' ? 'Download for Windows' : 'Download for Mac';
      main.setAttribute('aria-label', (primary === 'win-x64' ? 'Download for Windows' : 'Download for ' + NAMES[primary]) +
        (version ? ', version ' + version : '') + ', ' + mb(f.size));
      if (primary !== 'win-x64') bits.push(primary === 'mac-arm64' ? 'Apple silicon' : 'Intel');
      bits.push(mb(f.size));
    } else {
      main.hidden = true;
    }
    bits.push('Beta · free while in preview');
    meta.textContent = bits.join(' · ');

    // The other builds: small links. On a Mac the Intel build reads "Intel Mac?" (and the reverse).
    var rest = keys.filter(function (k) { return k !== primary; });
    if (!primary) {
      var lead = document.createElement('span');
      lead.textContent = 'AirBridge runs on Mac and Windows. Download for ';
      other.appendChild(lead);
    }
    rest.forEach(function (k, i) {
      if (i > 0) other.appendChild(document.createTextNode(primary ? ' · ' : i === rest.length - 1 ? ' or ' : ', '));
      var text = NAMES[k];
      if (primary && primary.indexOf('mac') === 0 && k === 'mac-x64') text = 'Intel Mac?';
      if (primary && primary.indexOf('mac') === 0 && k === 'mac-arm64') text = 'Apple silicon Mac?';
      if (primary === 'win-x64' && k.indexOf('mac') === 0) text = k === 'mac-arm64' ? 'Mac (Apple silicon)' : 'Mac (Intel)';
      other.appendChild(link(byKey[k], text));
    });
    if (!primary) other.appendChild(document.createTextNode('.'));

    note.textContent = os === 'mac' ? NOTES.mac : os === 'win' ? NOTES.win : NOTES.mac + ' ' + NOTES.win;
  }

  var settled = false;
  function once(fn) { return function (x, y) { if (settled) return; settled = true; clearTimeout(timer); fn(x, y); }; }
  var timer = setTimeout(once(soonState), 6000);
  fetch('/downloads/latest.json', { credentials: 'omit', cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (m) {
      if (!m || typeof m !== 'object') throw new Error('bad manifest');
      return (os === 'mac' ? macArch() : Promise.resolve('arm64')).then(once(function (arch) { render(m, arch); }));
    })
    .catch(once(soonState));
})();
