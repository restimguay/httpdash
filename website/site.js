'use strict';

// Suggest the download for the visitor's platform, wire up copy buttons, and keep the year current.
(() => {
  const ua = navigator.userAgent || '';
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /Win/i.test(platform) || /Windows/i.test(ua) ? 'windows'
    : /Mac/i.test(platform) || /Mac OS X/i.test(ua) ? 'mac'
    : /Linux/i.test(platform) && !/Android/i.test(ua) ? 'linux' : null;
  const primary = document.getElementById('primary-download');
  if (os && primary) {
    primary.textContent = `Download for ${{ windows: 'Windows', mac: 'macOS', linux: 'Linux' }[os]}`;
    const card = document.querySelector(`.dl-card[data-os="${os}"]`);
    if (card) card.classList.add('suggested');
  }

  document.querySelectorAll('.copy[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const label = btn.textContent;
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { btn.textContent = label; }, 1600);
    });
  });

  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
