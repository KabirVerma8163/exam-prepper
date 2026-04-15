// Theme toggle — runs on every page
(function () {
  const STORAGE_KEY = 'ep_theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Update all toggle buttons on the page
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.textContent = theme === 'dark' ? '☀' : '☾';
      btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  // Apply saved theme immediately (before paint) to avoid flash
  const saved = localStorage.getItem(STORAGE_KEY) || 'light';
  applyTheme(saved);

  // Wire up buttons once DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.addEventListener('click', toggleTheme);
    });
    // Re-apply to set button labels correctly after DOM is ready
    applyTheme(localStorage.getItem(STORAGE_KEY) || 'light');
  });
})();
