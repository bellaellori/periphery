/* Progressive enhancement only. Every interaction here works without JS —
   the forms post and the page re-renders. This just avoids losing your place. */
(function () {
  'use strict';

  function setState(form, saved) {
    var btn = form.querySelector('.flagbtn');
    var label = form.querySelector('.flagbtn__label');
    btn.classList.toggle('is-saved', saved);
    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    btn.setAttribute('aria-label',
      saved ? 'Saved to My Research — click to remove' : 'Save to My Research');
    btn.setAttribute('title', 'Save to My Research');
    if (label) label.textContent = saved ? 'Saved' : 'Save';
  }

  function bumpCount(delta) {
    var el = document.querySelector('.nav__count');
    if (el) {
      var n = Math.max(0, (parseInt(el.textContent, 10) || 0) + delta);
      el.textContent = n;
      return;
    }
    var link = document.querySelector('.nav a[href="/research"]');
    if (link && delta > 0) {
      var span = document.createElement('span');
      span.className = 'nav__count';
      span.textContent = '1';
      link.appendChild(document.createTextNode(' '));
      link.appendChild(span);
    }
  }

  // ---------------------------------------------------------------- share
  // Share hands the link to whatever the device already has — on a phone that
  // includes Notion, which is one tap from here into a database. Copy puts the
  // entry and its link on the clipboard as plain prose, ready to paste.
  // Neither needs a server, an account or a token.

  function compose(d) {
    return [d.title, d.line, '', d.body, '', d.url]
      .filter(function (s) { return s !== undefined && s !== null; })
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function flash(btn, word) {
    var label = btn.querySelector('.iconbtn__label');
    if (!label) return;
    if (btn.dataset.was === undefined) btn.dataset.was = label.textContent;
    label.textContent = word;
    btn.classList.add('is-done');
    clearTimeout(btn._t);
    btn._t = setTimeout(function () {
      label.textContent = btn.dataset.was;
      btn.classList.remove('is-done');
    }, 1800);
  }

  function toClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
                                                      function () { return legacy(text); });
    }
    return Promise.resolve(legacy(text));
  }

  // Clipboard access is blocked in some embedded contexts; this still works there.
  function legacy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err) { return false; }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.iconbtn');
    if (!btn) return;
    var box = btn.closest('[data-share]');
    if (!box) return;
    e.preventDefault();

    var d = box.dataset;
    var text = compose(d);

    if (btn.dataset.act === 'share' && navigator.share) {
      var payload = { title: d.title, text: d.body || d.title };
      if (d.url) payload.url = d.url;
      navigator.share(payload).catch(function (err) {
        // A cancelled share sheet is not a failure; anything else falls back.
        if (err && err.name === 'AbortError') return;
        toClipboard(text).then(function (ok) { flash(btn, ok ? 'Copied' : 'Blocked'); });
      });
      return;
    }

    toClipboard(text).then(function (ok) {
      flash(btn, ok ? 'Copied' : 'Blocked');
    });
  });

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-relevance]');
    if (!form) return;
    e.preventDefault();

    var id = form.getAttribute('data-id');
    var btn = form.querySelector('.flagbtn');
    var saved = btn.classList.contains('is-saved');
    var method = saved ? 'DELETE' : 'POST';

    btn.disabled = true;
    fetch('/api/articles/' + id + '/relevant', {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function () {
        // Every button for this article on the page moves together.
        document.querySelectorAll('form[data-relevance][data-id="' + id + '"]')
          .forEach(function (f) { setState(f, !saved); });
        bumpCount(saved ? -1 : 1);
      })
      .catch(function () { form.submit(); })   // fall back to the real post
      .finally(function () { btn.disabled = false; });
  });
})();
