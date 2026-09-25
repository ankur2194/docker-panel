// Applies the saved colour theme before the first paint (loaded from <head>, so no flash).
// Saved choice: localStorage 'dp:theme' = system | light | dark. <html data-theme> is always light or dark.
(function () {
  var media = window.matchMedia('(prefers-color-scheme: light)');
  function pref() {
    try { return localStorage.getItem('dp:theme') || 'system'; } catch (e) { return 'system'; }
  }
  function apply(p) {
    p = p || pref();
    document.documentElement.dataset.theme = p === 'light' || p === 'dark' ? p : media.matches ? 'light' : 'dark';
  }
  apply();
  media.addEventListener('change', function () { apply(); });
  window.dpApplyTheme = apply;
})();
