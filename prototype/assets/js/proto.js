/* Shared prototype behaviour: theme persistence + toggle.
   Static prototype only — none of this survives into the implementation. */

(function () {
  var KEY = 'cockpit-proto-theme';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  var initial = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initial);

  window.toggleTheme = function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
    document.querySelectorAll('[data-theme-label]').forEach(function (el) {
      el.textContent = next === 'dark' ? 'light' : 'dark';
    });
  };

  document.addEventListener('DOMContentLoaded', function () {
    var t = document.documentElement.getAttribute('data-theme');
    document.querySelectorAll('[data-theme-label]').forEach(function (el) {
      el.textContent = t === 'dark' ? 'light' : 'dark';
    });
  });
})();

/* Terminal copy. Copies the command text only — prompts and sample output are
   marked so they never end up on the clipboard. */
window.copyTerm = function (btn) {
  var body = btn.closest('.term').querySelector('.term-body').cloneNode(true);
  body.querySelectorAll('.t-prompt, .t-out, .t-comment').forEach(function (n) { n.remove(); });
  var text = body.textContent.replace(/[ \t]+\n/g, '\n').trim();

  var done = function () {
    btn.setAttribute('data-copied', '');
    clearTimeout(btn._t);
    btn._t = setTimeout(function () { btn.removeAttribute('data-copied'); }, 1600);
  };

  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
  else done();
};

/* ---------------------------------------------------------------------------
   Palette. One implementation for ⌘K and for every picker, so there is one
   keyboard model to learn and one to keep working.

   Pages declare their palettes in window.PALETTES:
     { key: { placeholder, groups: [{ label, items: [{icon, name, hint}] }] } }
   --------------------------------------------------------------------------- */

(function () {
  var el, input, list, sel = 0, flat = [], current = null;

  function build() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'scrim';
    el.innerHTML =
      '<div class="palette">' +
        '<div class="palette-input">' +
          '<svg class="icon icon-sm"><use href="#search"/></svg>' +
          '<input autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="palette-list"></div>' +
      '</div>';
    document.body.appendChild(el);
    input = el.querySelector('input');
    list = el.querySelector('.palette-list');

    el.addEventListener('mousedown', function (e) { if (e.target === el) close(); });
    input.addEventListener('input', function () { render(input.value); });
  }

  function render(q) {
    q = (q || '').trim().toLowerCase();
    var html = '';
    flat = [];
    (current.groups || []).forEach(function (g) {
      var hits = g.items.filter(function (i) {
        return !q || (i.name + ' ' + (i.hint || '')).toLowerCase().indexOf(q) > -1;
      });
      if (!hits.length) return;
      html += '<div class="palette-group">' + g.label + '</div>';
      hits.forEach(function (i) {
        var idx = flat.length;
        flat.push(i);
        html += '<button class="palette-item" data-i="' + idx + '">' +
                  (i.icon ? '<svg class="icon icon-sm"><use href="#' + i.icon + '"/></svg>' : '') +
                  '<span class="p-name">' + i.name + '</span>' +
                  (i.hint ? '<span class="p-hint">' + i.hint + '</span>' : '') +
                '</button>';
      });
    });
    list.innerHTML = html || '<div class="palette-empty">Nothing matches &ldquo;' + q + '&rdquo;.</div>';
    sel = 0;
    mark();
    list.querySelectorAll('.palette-item').forEach(function (b) {
      b.addEventListener('mousemove', function () { sel = +b.dataset.i; mark(); });
      b.addEventListener('click', function () { commit(); });
    });
  }

  function mark() {
    list.querySelectorAll('.palette-item').forEach(function (b) {
      if (+b.dataset.i === sel) { b.setAttribute('data-sel', ''); b.scrollIntoView({ block: 'nearest' }); }
      else b.removeAttribute('data-sel');
    });
  }

  function commit() {
    var item = flat[sel];
    close();
    if (item) (current.onPick || function (i) { alert('Picked: ' + i.name); })(item);
  }

  window.openPalette = function (key) {
    build();
    current = (window.PALETTES || {})[key] || { placeholder: 'Search…', groups: [] };
    input.placeholder = current.placeholder || 'Search…';
    input.value = '';
    render('');
    el.setAttribute('data-open', '');
    input.focus();
  };

  function close() { if (el) el.removeAttribute('data-open'); }
  window.closePalette = close;

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      window.openPalette('command');
      return;
    }
    if (!el || !el.hasAttribute('data-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, flat.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
})();
