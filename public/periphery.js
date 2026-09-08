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
