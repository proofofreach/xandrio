fetch('passages.json').then(response => response.json()).then(passages => {
  document.getElementById('p1-text').textContent = passages.p1;
  document.getElementById('p2-text').textContent = passages.p2;
}).catch(() => {});
