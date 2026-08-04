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
