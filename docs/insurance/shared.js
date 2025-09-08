<script>
async function loadShared(){
const header = await fetch('header.html').then(r=>r.text());
const footer = await fetch('footer.html').then(r=>r.text());
document.getElementById('header').innerHTML = header;
document.getElementById('footer').innerHTML = footer;
document.getElementById('year').textContent = new Date().getFullYear();
}
loadShared();
</script>
