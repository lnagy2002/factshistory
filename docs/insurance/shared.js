(async () => {
  const headerHtml = await fetch('header.html').then(r => r.text());
  const footerHtml = await fetch('footer.html').then(r => r.text());
  document.getElementById('header').innerHTML = headerHtml;
  document.getElementById('footer').innerHTML = footerHtml;
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();

async function loadData() {
    try {
        const res = await fetch('https://lnagy2002.github.io/factshistory/insurance/data/articles.json'); // <-- your JSON file
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        articles = await res.json();   
    } catch (err) {
      console.error  (err);
    }
}

loadData ();
