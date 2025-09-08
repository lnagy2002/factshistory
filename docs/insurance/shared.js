(async () => {
  const headerHtml = await fetch('partials/header.html').then(r => r.text());
  const footerHtml = await fetch('partials/footer.html').then(r => r.text());
  document.getElementById('header').innerHTML = headerHtml;
  document.getElementById('footer').innerHTML = footerHtml;
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
