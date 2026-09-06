if (location.search.includes('debug=1')) {
    const erudaScript = document.createElement('script');
    erudaScript.src = 'https://cdn.jsdelivr.net/npm/eruda';
    erudaScript.onload = () => window.eruda && window.eruda.init();
    document.body.appendChild(erudaScript);
  }
