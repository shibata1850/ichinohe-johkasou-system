(function () {
  const { api } = window.App;
  const form = document.getElementById('loginForm');
  const err = document.getElementById('err');
  const next = new URLSearchParams(location.search).get('next');
  const homeFor = (u) => (u.role === 'admin' ? '/admin' : '/staff');

  fetch('/api/config').then((r) => r.json()).then((c) => {
    if (c.demo) document.getElementById('demoBox').classList.remove('hidden');
  }).catch(() => {});

  // ログイン済みならそのまま移動
  fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((u) => {
    if (u) location.replace(next && next.startsWith('/') ? next : homeFor(u));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const login_id = form.login_id.value.trim();
    const password = form.password.value;
    if (!login_id || !password) {
      err.textContent = 'ログインIDとパスワードを入力してください';
      err.classList.remove('hidden');
      return;
    }
    try {
      const u = await api('POST', '/api/login', { login_id, password });
      const dest = next && next.startsWith('/') && !(next.startsWith('/admin') && u.role !== 'admin') ? next : homeFor(u);
      location.href = dest;
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
})();
