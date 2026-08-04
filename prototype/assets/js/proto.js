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
