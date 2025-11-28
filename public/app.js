function checkAuth(adminOnly = false) {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (!token || !user) { location.href = 'index.html'; return; }
    if (adminOnly && !user.is_admin) { alert('Acesso negado'); location.href = 'dashboard.html'; return; }
    const el = document.getElementById('userName');
    if (el) el.textContent = `Olá, ${user.nome.split(' ')[0]}!`;
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.href = 'index.html';
}

async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('token');
    if (!token) { logout(); return; }

    const headers = { 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

    const resp = await fetch(url, { ...options, headers, credentials: "include" });
    if (resp.status === 401) { alert('Sessão expirada'); logout(); }
    return resp;
}