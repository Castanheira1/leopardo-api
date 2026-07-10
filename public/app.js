/* ============================================================
   VAP - utilidades globais (auth, mapa, câmera, OCR)
   ============================================================ */

function checkAuth(adminOnly = false) {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (!token || !user) { location.href = 'index.html'; return; }
    if (adminOnly && !user.is_admin) { avisoProximaPagina('Acesso restrito a administradores.'); location.href = 'dashboard.html'; return; }
    const el = document.getElementById('userName');
    if (el) el.textContent = `Olá, ${user.nome.split(' ')[0]}!`;
    // LGPD: quem se cadastrou antes do consentimento precisa aceitar a política
    // para continuar usando o app. Verifica no servidor e, se pendente, mostra o
    // portão bloqueante. Fire-and-forget (não trava o resto do carregamento).
    verificarConsentimentoLGPD();
}

/* -------------------- LGPD: portão de consentimento -------------------- */
const POLITICA_VERSAO = '1.0';
async function verificarConsentimentoLGPD() {
    try {
        if (!localStorage.getItem('token')) return;
        if (document.getElementById('lgpdGate')) return; // já aberto
        const r = await fetchWithAuth('/api/perfil');
        if (!r || !r.ok) return;
        const user = await r.json();
        // mantém o localStorage em dia (usuários antigos não tinham o campo)
        try { localStorage.setItem('user', JSON.stringify(user)); } catch (_) {}
        if (user.politica_pendente) mostrarPortaoConsentimento();
    } catch (_) { /* sem consentimento pendente ou offline: não bloqueia */ }
}

function mostrarPortaoConsentimento() {
    if (document.getElementById('lgpdGate')) return;
    const gate = document.createElement('div');
    gate.id = 'lgpdGate';
    gate.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(3,20,21,.92);' +
        'display:flex;align-items:center;justify-content:center;padding:20px;';
    gate.innerHTML = `
        <div style="max-width:440px;width:100%;background:#0b2e2f;border:1px solid rgba(234,210,152,.25);
                    border-radius:16px;padding:24px 22px;color:#e8eef0;font-family:inherit;">
            <h2 style="color:#EAD298;margin:0 0 10px;font-size:1.25rem;">Atualização de privacidade</h2>
            <p style="line-height:1.55;margin:0 0 12px;">
                Para continuar usando o VAP, precisamos do seu aceite da
                <a href="politica-privacidade.html" target="_blank" rel="noopener" style="color:#EAD298;">Política de Privacidade</a>.
                Ela explica como usamos sua selfie, foto do veículo e localização (GPS)
                para a segurança das caronas, conforme a LGPD.
            </p>
            <div id="lgpdGateMsg" style="display:none;color:#ff9b9b;font-size:.9rem;margin-bottom:10px;"></div>
            <button id="lgpdAceitar" type="button"
                style="width:100%;padding:13px;border:none;border-radius:10px;background:#EAD298;color:#0F3D3E;
                       font-weight:700;font-size:1rem;cursor:pointer;">Li e aceito a Política de Privacidade</button>
            <button id="lgpdSair" type="button"
                style="width:100%;padding:11px;margin-top:10px;border:1px solid rgba(255,255,255,.2);border-radius:10px;
                       background:transparent;color:#c9d4d5;font-size:.92rem;cursor:pointer;">Agora não (sair)</button>
        </div>`;
    document.body.appendChild(gate);

    gate.querySelector('#lgpdSair').onclick = () => logout();
    const btn = gate.querySelector('#lgpdAceitar');
    btn.onclick = async () => {
        btn.disabled = true;
        try {
            const r = await fetchWithAuth('/api/perfil/aceitar-politica', {
                method: 'POST',
                body: JSON.stringify({ politica_versao: POLITICA_VERSAO }),
            });
            if (!r || !r.ok) throw new Error('falha');
            const user = await r.json();
            try { localStorage.setItem('user', JSON.stringify(user)); } catch (_) {}
            gate.remove();
            mostrarToast('Consentimento registrado. Obrigado!');
        } catch (_) {
            btn.disabled = false;
            const m = gate.querySelector('#lgpdGateMsg');
            m.textContent = 'Não foi possível registrar o aceite. Tente de novo.';
            m.style.display = 'block';
        }
    };
}

/* -------------------- Toast global (substitui alert) -------------------- */
// Reusa o #message da página quando existe; senão cria um flutuante no topo.
function mostrarToast(texto, tipo = 'success') {
    let m = document.getElementById('message');
    if (!m) {
        m = document.createElement('div');
        m.id = 'message';
        m.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;max-width:92vw;';
        document.body.appendChild(m);
    }
    m.className = 'message ' + tipo;
    m.textContent = texto;
    m.style.display = 'block';
    clearTimeout(m._t);
    m._t = setTimeout(() => { m.style.display = 'none'; }, 5000);
}
// Aviso que precisa sobreviver a um redirect (ex.: sessão expirada → login):
// grava agora, e a próxima página mostra ao carregar.
function avisoProximaPagina(texto) {
    try { sessionStorage.setItem('flashToast', texto); } catch (_) {}
}
document.addEventListener('DOMContentLoaded', () => {
    try {
        const t = sessionStorage.getItem('flashToast');
        if (t) { sessionStorage.removeItem('flashToast'); mostrarToast(t, 'error'); }
    } catch (_) {}
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        preCarregarOcr();
    }
});

// Aviso de conexão: toast temporário (some sozinho), sem tarja fixa na tela.
(function avisoConexao() {
    let avisouOffline = false;
    function aoFicarOffline() {
        if (avisouOffline) return;
        avisouOffline = true;
        mostrarToast('Sem conexão — mostrando a última versão carregada', 'error');
    }
    function aoVoltarOnline() {
        if (!avisouOffline) return;
        avisouOffline = false;
        mostrarToast('Conexão restabelecida', 'success');
    }
    window.addEventListener('offline', aoFicarOffline);
    window.addEventListener('online', aoVoltarOnline);
    if (!navigator.onLine) aoFicarOffline();
})();

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.replace('index.html');
}

// Impede que o botão voltar do celular saia do app (como se tivesse clicado em Sair).
// Fecha modais/painéis primeiro; só logout() encerra a sessão de propósito.
function instalarGuardaVoltar(fecharCamada, opts = {}) {
    const bloquearSaida = opts.bloquearSaida !== false;
    if (!localStorage.getItem('token')) return;
    const empilhar = () => {
        try { history.pushState({ vapGuard: 1 }, '', location.href); } catch (_) {}
    };
    try { history.replaceState({ vapRoot: 1 }, '', location.href); } catch (_) {}
    if (bloquearSaida) empilhar();
    window.addEventListener('popstate', () => {
        // Re-empilha SEMPRE e PRIMEIRO: o voltar nunca sai do app, mesmo que
        // fecharCamada lance erro. Só depois tenta fechar uma camada aberta.
        if (bloquearSaida) empilhar();
        try { if (typeof fecharCamada === 'function') fecharCamada(); } catch (_) {}
    });
    // Capacitor (APK): sem um listener de backButton o Android FECHA o app no
    // voltar (o popstate acima nem chega a rodar). Com o listener, o voltar passa
    // a fechar camadas/ficar no app, igual à PWA. No-op se o plugin não existir.
    try {
        const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
        if (capApp && capApp.addListener) {
            capApp.addListener('backButton', () => {
                try { if (typeof fecharCamada === 'function') fecharCamada(); } catch (_) {}
            });
        }
    } catch (_) {}
}

async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('token');
    if (!token) { logout(); return; }

    const headers = { 'Authorization': `Bearer ${token}` };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

    const resp = await fetch(url, { ...options, headers, credentials: 'include' });
    if (resp.status === 401) { avisoProximaPagina('Sessão expirada. Entre novamente.'); logout(); }
    return resp;
}

/* -------------------- Notificações push (Web Push) -------------------- */
function _b64ToUint8(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
// Inscreve o aparelho para receber notificações. Idempotente e à prova de erro:
// se o navegador não suporta, a permissão é negada ou não há chave, apenas sai.
let _pushPronto = false;
async function registrarPush(silencioso = false) {
    try {
        if (_pushPronto) return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
        if (!localStorage.getItem('token')) return;
        if (Notification.permission === 'denied') return;
        // Modo silencioso (no carregamento): só sincroniza se a permissão já existe,
        // sem disparar o popup. O popup só aparece num gesto do usuário.
        if (Notification.permission === 'default' && silencioso) return;

        const cfg = await (await fetch('/api/config')).json();
        if (!cfg.pushPublicKey) return;   // servidor sem VAPID: push desligado

        if (Notification.permission === 'default') {
            const p = await Notification.requestPermission();
            if (p !== 'granted') return;
        }

        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: _b64ToUint8(cfg.pushPublicKey),
            });
        }
        const r = await fetchWithAuth('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
        if (r && r.ok) _pushPronto = true;
    } catch (_) { /* nunca quebra o app por causa de notificação */ }
}

/* -------------------- Carregamento de scripts externos -------------------- */
const _scriptsCarregados = {};
function carregarScript(src) {
    if (_scriptsCarregados[src]) return _scriptsCarregados[src];
    _scriptsCarregados[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Falha ao carregar ' + src));
        document.head.appendChild(s);
    });
    return _scriptsCarregados[src];
}

/* -------------------- Google Maps (APIs novas: marker, routes, places) -------------------- */
let _mapsPromise = null;
let _mapId = 'DEMO_MAP_ID';
let _RouteClass = null;
let _AdvancedMarkerElement = null;
let _PinElement = null;

function opcoesMapa(opts = {}) {
    const o = { mapId: _mapId, ...opts };
    // Vector + DEMO_MAP_ID dispara RPC interno GetViewportInfo (502/CORS intermitente).
    if (!o.renderingType && window.google?.maps?.RenderingType) {
        o.renderingType = google.maps.RenderingType.RASTER;
    }
    return o;
}

function normalizarLatLng(pos) {
    if (!pos) return null;
    if (typeof pos.lat === 'function') return { lat: pos.lat(), lng: pos.lng() };
    return { lat: Number(pos.lat), lng: Number(pos.lng) };
}

function posicaoLegada(mk) {
    const p = mk?.position ?? mk;
    if (!p) return null;
    const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
    const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
    return { lat: () => lat, lng: () => lng };
}

function formatarMetros(m) {
    const n = Number(m);
    if (!Number.isFinite(n)) return '';
    return n >= 1000 ? (n / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(n) + ' m';
}

function manobraLegada(m) {
    if (!m) return '';
    return String(m).toLowerCase().replace(/_/g, '-');
}

function formatarDuracaoMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const min = Math.round(n / 60000);
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

function haversineKmApp(lat1, lng1, lat2, lng2) {
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function respostaRotaLegada(route) {
    const leg = route.legs?.[0];
    const distText = route.localizedValues?.distance?.text
        || leg?.localizedValues?.distance?.text
        || formatarMetros(route.distanceMeters ?? leg?.distanceMeters);
    const durText = route.localizedValues?.duration?.text
        || leg?.localizedValues?.duration?.text
        || formatarDuracaoMs(route.durationMillis ?? leg?.durationMillis);
    const steps = (leg?.steps || []).map((s) => ({
        distance: { text: s.localizedValues?.distance?.text || formatarMetros(s.distanceMeters) },
        maneuver: manobraLegada(s.navigationInstruction?.maneuver),
        instructions: s.navigationInstruction?.instructions || '',
    }));
    return {
        routes: [{ legs: [{ distance: { text: distText }, duration: { text: durText }, steps }] }],
        _route: route,
        km: Math.round(((route.distanceMeters ?? leg?.distanceMeters ?? 0) / 1000) * 100) / 100,
    };
}

function respostaRotaFallback(o, d) {
    const distKm = haversineKmApp(o.lat, o.lng, d.lat, d.lng);
    const distText = distKm >= 1
        ? distKm.toFixed(1).replace('.', ',') + ' km'
        : Math.round(distKm * 1000) + ' m';
    const min = Math.max(1, Math.round((distKm / 35) * 60));
    return {
        routes: [{ legs: [{ distance: { text: distText }, duration: { text: min + ' min' }, steps: [] }] }],
        _fallbackLine: [o, d],
        km: Math.round(distKm * 100) / 100,
    };
}

function instalarMapsBootstrap(apiKey) {
    if (window.google?.maps?.importLibrary) return Promise.resolve();
    if (window.__vapMapsBootstrap) return window.__vapMapsBootstrap;
    window.__vapMapsBootstrap = new Promise((resolve, reject) => {
        try {
            (g => {
                var h, a, k, p = 'The Google Maps JavaScript API', c = 'google', l = 'importLibrary', q = '__ib__', m = document, b = window;
                b = b[c] || (b[c] = {});
                var d = b.maps || (b.maps = {}), r = new Set, e = new URLSearchParams,
                    u = () => h || (h = new Promise(async (f, n) => {
                        await (a = m.createElement('script'));
                        e.set('libraries', [...r] + '');
                        for (k in g) e.set(k.replace(/[A-Z]/g, t => '_' + t[0].toLowerCase()), g[k]);
                        e.set('callback', c + '.maps.' + q);
                        a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
                        d[q] = f;
                        a.onerror = () => n(new Error(p + ' could not load.'));
                        a.nonce = m.querySelector('script[nonce]')?.nonce || '';
                        m.head.append(a);
                    }));
                d[l] ? null : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n));
            })({ key: apiKey, v: 'weekly' });
            google.maps.importLibrary('maps').then(resolve).catch(reject);
        } catch (err) {
            reject(err);
        }
    });
    return window.__vapMapsBootstrap;
}

function carregarMaps() {
    if (_mapsPromise) return _mapsPromise;
    _mapsPromise = (async () => {
        const cfg = await (await fetch('/api/config')).json();
        if (!cfg.mapsApiKey) throw new Error('Google Maps API key não configurada (.env GOOGLE_MAPS_API_KEY)');
        _mapId = cfg.mapsMapId || 'DEMO_MAP_ID';
        await instalarMapsBootstrap(cfg.mapsApiKey);
        const [, markerLib, routesLib] = await Promise.all([
            google.maps.importLibrary('maps'),
            google.maps.importLibrary('marker'),
            google.maps.importLibrary('routes'),
            google.maps.importLibrary('places'),
        ]);
        _RouteClass = routesLib.Route;
        _AdvancedMarkerElement = markerLib.AdvancedMarkerElement;
        _PinElement = markerLib.PinElement;
        return window.google;
    })().catch((err) => { _mapsPromise = null; throw err; });
    return _mapsPromise;
}

// Carro visto de cima (o ícone gira com o rumo, então a vista é sempre top-down),
// com sombreamento, faróis, lanternas, retrovisores e pneus para parecer um
// carro de verdade mesmo em 30×40 px. 'gold' é o dourado clássico da frota
// online; 'white' (nome legado) é o modelo dourado com detalhes PRETOS do
// carro próprio — o branco puro sumia no mapa claro.
function carSvgPaths(variant = 'white') {
    const dourado = variant === 'gold';
    const body = '#EAD298';
    const bodyEdge = dourado ? '#c9a94f' : '#b8963d';
    const stroke = dourado ? '#9a7514' : '#111111';
    const glassRoof = dourado ? '#2f3640' : '#101418';
    const glass = dourado ? '#455a64' : '#232e38';
    const detail = dourado ? '#9a7514' : '#1a1a1a';
    const gid = 'vap-car-body-' + variant;
    return `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">`
        + `<stop offset="0" stop-color="${bodyEdge}"/><stop offset="0.3" stop-color="${body}"/>`
        + `<stop offset="0.7" stop-color="${body}"/><stop offset="1" stop-color="${bodyEdge}"/>`
        + `</linearGradient></defs>`
        // pneus (só a pontinha aparece, dos lados)
        + `<rect x="7.6" y="13.5" width="3" height="9" rx="1.5" fill="#15181b"/>`
        + `<rect x="37.4" y="13.5" width="3" height="9" rx="1.5" fill="#15181b"/>`
        + `<rect x="7.6" y="42.5" width="3" height="9" rx="1.5" fill="#15181b"/>`
        + `<rect x="37.4" y="42.5" width="3" height="9" rx="1.5" fill="#15181b"/>`
        // retrovisores
        + `<path d="M9.8 16.2 C7.8 15.6 6.6 16.4 6.9 17.8 C7.1 19 8.6 19.4 10.2 18.8 Z" fill="${detail}"/>`
        + `<path d="M38.2 16.2 C40.2 15.6 41.4 16.4 41.1 17.8 C40.9 19 39.4 19.4 37.8 18.8 Z" fill="${detail}"/>`
        // carroceria (ombros largos, frente e traseira arredondadas)
        + `<path d="M24 2.8 C17.2 2.8 12.6 6 11.4 11.6 C10.4 16 9.8 20 9.8 25.5 L9.8 49 C9.8 56.4 14.2 60.8 24 60.8 C33.8 60.8 38.2 56.4 38.2 49 L38.2 25.5 C38.2 20 37.6 16 36.6 11.6 C35.4 6 30.8 2.8 24 2.8 Z" fill="url(#${gid})" stroke="${stroke}" stroke-width="1.2"/>`
        // vinco do capô
        + `<path d="M15.5 7.2 C18.5 5.4 29.5 5.4 32.5 7.2" fill="none" stroke="${detail}" stroke-width="0.8" opacity="0.55"/>`
        // faróis
        + `<path d="M12.3 5.8 C13.8 4.5 16 4 17.6 4.1 L17 6.9 C15.4 6.6 13.8 6.9 12.9 7.8 Z" fill="#fffdf2"/>`
        + `<path d="M35.7 5.8 C34.2 4.5 32 4 30.4 4.1 L31 6.9 C32.6 6.6 34.2 6.9 35.1 7.8 Z" fill="#fffdf2"/>`
        // brilho do capô
        + `<ellipse cx="24" cy="10.5" rx="8" ry="2.6" fill="#ffffff" opacity="0.28"/>`
        // para-brisa
        + `<path d="M14.2 16.8 C17.6 14.4 30.4 14.4 33.8 16.8 L35 26.5 C27.5 24.8 20.5 24.8 13 26.5 Z" fill="${glass}"/>`
        // teto de vidro
        + `<path d="M13.2 28.3 C20 26.6 28 26.6 34.8 28.3 L33.6 41.8 C28 40.5 20 40.5 14.4 41.8 Z" fill="${glassRoof}"/>`
        // reflexo diagonal no vidro
        + `<path d="M16 17.5 C19 15.8 24 15.6 27 16.2 L15.6 30 C15 29.4 14.6 28.4 14.8 27 Z" fill="#ffffff" opacity="0.10"/>`
        // vidro traseiro
        + `<path d="M15.2 43.6 C20.4 42.4 27.6 42.4 32.8 43.6 L31.4 49.6 C26.8 48.6 21.2 48.6 16.6 49.6 Z" fill="${glass}"/>`
        // brilho do porta-malas
        + `<ellipse cx="24" cy="52.6" rx="7.5" ry="1.8" fill="#ffffff" opacity="0.22"/>`
        // lanternas
        + `<path d="M14.6 56.9 C17 57.8 21 58.2 24 58.2 C27 58.2 31 57.8 33.4 56.9 L33 54.4 C30 55.2 27 55.5 24 55.5 C21 55.5 18 55.2 15 54.4 Z" fill="#e53935"/>`;
}

function htmlSvgCarro(variant, w, h) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 64" width="${w}" height="${h}" style="display:block;pointer-events:none">${carSvgPaths(variant)}</svg>`;
}

function montarNoCarro(variant, w, h) {
    const rot = document.createElement('div');
    rot.className = 'vap-car-rot';
    rot.style.cssText = `width:${w}px;height:${h}px;transform-origin:50% 50%;transform:rotate(0deg) translateZ(0);`
        + 'backface-visibility:hidden;-webkit-backface-visibility:hidden;contain:layout style paint;';
    rot.innerHTML = htmlSvgCarro(variant, w, h);
    return rot;
}

function distMetrosGps(a, b) {
    if (!a || !b) return 0;
    const R = 6371000;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

function diferencaAngulo(a, b) {
    return Math.abs(((Number(a) - Number(b) + 540) % 360) - 180);
}

// Rumo (graus, 0 = norte) entre dois pontos — para orientar o ícone do carro.
function bearingEntrePontos(de, para) {
    if (!de || !para) return null;
    const dLat = Math.abs(de.lat - para.lat);
    const dLng = Math.abs(de.lng - para.lng);
    if (dLat < 1e-7 && dLng < 1e-7) return null;
    const lat1 = de.lat * Math.PI / 180;
    const lat2 = para.lat * Math.PI / 180;
    const dLngRad = (para.lng - de.lng) * Math.PI / 180;
    const y = Math.sin(dLngRad) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLngRad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Desliza o marcador da posição atual até a nova (tween ~2,8 s, cobrindo o
// intervalo do poll) — o carro "vive" no mapa, estilo bolinha do Google Maps
// em viagem, em vez de pular de ponto em ponto a cada atualização.
const _animCarro = new WeakMap();
function atualizarPosicaoCarro(mk, pos, posAnterior) {
    if (!mk) return;
    const anterior = _animCarro.get(mk);
    if (anterior && anterior.raf) cancelAnimationFrame(anterior.raf);
    const de = (anterior && anterior.atual) || posAnterior;

    if (de && mk.setHeading) {
        const metros = distMetrosGps(de, pos);
        if (metros >= 8) {   // GPS oscilando parado: não gira
            const h = bearingEntrePontos(de, pos);
            if (h != null) {
                const ultimo = mk.getHeading ? mk.getHeading() : null;
                if (ultimo == null || diferencaAngulo(ultimo, h) >= 18 || metros >= 35) mk.setHeading(h);
            }
        }
    }

    // Sem referência, parado ou salto grande (teleporte): aplica direto.
    if (!de || distMetrosGps(de, pos) < 1 || distMetrosGps(de, pos) > 2500) {
        mk.setPosition(pos);
        _animCarro.set(mk, { atual: { lat: pos.lat, lng: pos.lng }, raf: 0 });
        return;
    }
    const st = { de: { lat: de.lat, lng: de.lng }, atual: { lat: de.lat, lng: de.lng }, t0: performance.now(), raf: 0 };
    const passo = (ts) => {
        const t = Math.min(1, (ts - st.t0) / 2800);
        st.atual = {
            lat: st.de.lat + (pos.lat - st.de.lat) * t,
            lng: st.de.lng + (pos.lng - st.de.lng) * t,
        };
        mk.setPosition(st.atual);
        st.raf = t < 1 ? requestAnimationFrame(passo) : 0;
    };
    st.raf = requestAnimationFrame(passo);
    _animCarro.set(mk, st);
}

// Marcadores de carro redimensionam conforme o zoom do mapa (como Uber/Maps).
const _regZoomCar = new WeakMap();

function tamanhoCarroPorZoom(zoom) {
    const z = Math.max(10, Math.min(20, Number(zoom) || 15));
    const f = Math.pow(1.12, z - 15);   // zoom 15 = 30×40 px (referência)
    return { w: Math.round(30 * f), h: Math.round(40 * f) };
}

function vincularZoomCarros(map) {
    if (!map || _regZoomCar.has(map)) return;
    const set = new Set();
    _regZoomCar.set(map, set);
    const aplicar = () => {
        const tam = tamanhoCarroPorZoom(map.getZoom());
        set.forEach((mk) => { if (mk.setIconSize) mk.setIconSize(tam.w, tam.h); });
    };
    map.addListener('zoom_changed', aplicar);
    aplicar();
}

function registrarMarcadorCarro(map, marker) {
    if (!map || !marker?.setIconSize) return;
    vincularZoomCarros(map);
    _regZoomCar.get(map).add(marker);
    const tam = tamanhoCarroPorZoom(map.getZoom());
    marker.setIconSize(tam.w, tam.h);
}

function removerMarcadorCarro(map, marker) {
    const set = map && _regZoomCar.get(map);
    if (set) set.delete(marker);
}

// Marcador moderno (AdvancedMarkerElement) com API parecida com o Marker legado.
function criarMarcador(opts = {}) {
    const { map, position, title, icon, label, zIndex, cor, invisivel, badge, iconW, iconH, heading, iconVariant } = opts;
    let pinEl = null;
    let content = null;
    let imgEl = null;
    let rotEl = null;
    let wrapEl = null;
    let mapRef = map || null;
    if (invisivel) {
        const d = document.createElement('div');
        d.style.cssText = 'width:36px;height:36px;opacity:0.001;';
        content = d;
    } else if (iconVariant) {
        const iw = iconW || 30;
        const ih = iconH || 40;
        rotEl = montarNoCarro(iconVariant, iw, ih);
        if (badge != null) {
            const wrap = document.createElement('div');
            wrap.style.cssText = `position:relative;width:${iw}px;height:${ih}px;overflow:visible;`;
            const sel = document.createElement('span');
            sel.textContent = String(badge);
            sel.style.cssText = 'position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;'
                + 'padding:0 3px;border-radius:50%;background:#EAD298;color:#0F3D3E;'
                + 'font:700 11px/16px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.4);';
            wrap.appendChild(rotEl);
            wrap.appendChild(sel);
            content = wrap;
            wrapEl = wrap;
        } else {
            content = rotEl;
            wrapEl = rotEl;
        }
    } else if (typeof icon === 'string' && (icon.startsWith('http') || icon.startsWith('data:'))) {
        const img = document.createElement('img');
        img.src = icon;
        const iw = iconW || 44;
        const ih = iconH || 44;
        img.style.width = iw + 'px';
        img.style.height = ih + 'px';
        img.draggable = false;
        imgEl = img;
        if (iconVariant || heading != null) {
            img.style.transformOrigin = 'center center';
            img.style.willChange = 'transform';
        }
        if (heading != null) img.style.transform = `rotate(${Number(heading) || 0}deg)`;
        if (badge != null) {
            // Selo numerado (posição na fila) por cima do ícone do carro.
            const wrap = document.createElement('div');
            wrap.style.cssText = `position:relative;width:${iw}px;height:${ih}px;`;
            const sel = document.createElement('span');
            sel.textContent = String(badge);
            sel.style.cssText = 'position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;'
                + 'padding:0 3px;border-radius:50%;background:#EAD298;color:#0F3D3E;'
                + 'font:700 11px/16px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.4);';
            wrap.appendChild(img);
            wrap.appendChild(sel);
            content = wrap;
            wrapEl = wrap;
        } else {
            content = img;
            wrapEl = img;
        }
    } else if (label || cor) {
        const pinOpts = {
            background: cor || '#EA4335',
            borderColor: '#fff',
            glyphColor: '#fff',
            scale: label ? 1.1 : 0.85,
        };
        if (label) pinOpts.glyphText = label;
        pinEl = new _PinElement(pinOpts);
    }
    const mk = new _AdvancedMarkerElement({
        map: map || null,
        position: normalizarLatLng(position),
        title: title || '',
        content: content || null,
        zIndex,
    });
    if (pinEl) mk.append(pinEl);
    let _headingDeg = heading != null ? Number(heading) || 0 : 0;
    const aplicarRotacao = () => {
        if (!rotEl) return;
        rotEl.style.transform = `rotate(${_headingDeg}deg) translateZ(0)`;
    };
    const api = {
        setPosition(p) { mk.position = normalizarLatLng(p); },
        getPosition() { return posicaoLegada(mk); },
        setMap(m) {
            if (!m && mapRef && iconVariant) removerMarcadorCarro(mapRef, api);
            mk.map = m;
            if (m) {
                mapRef = m;
                if (iconVariant) registrarMarcadorCarro(m, api);
            }
        },
        setTitle(t) { mk.title = t || ''; },
        getHeading() { return _headingDeg; },
        setHeading(h) {
            if (!rotEl && !imgEl) return;
            _headingDeg = Number(h) || 0;
            if (rotEl) {
                aplicarRotacao();
                return;
            }
            if (imgEl) imgEl.style.transform = `rotate(${_headingDeg}deg) translateZ(0)`;
        },
        setIconSize(w, h) {
            if (rotEl) {
                rotEl.style.width = w + 'px';
                rotEl.style.height = h + 'px';
                const svg = rotEl.querySelector('svg');
                if (svg) { svg.setAttribute('width', w); svg.setAttribute('height', h); }
            } else if (imgEl) {
                imgEl.style.width = w + 'px';
                imgEl.style.height = h + 'px';
            } else return;
            if (wrapEl && wrapEl !== rotEl && wrapEl !== imgEl) {
                wrapEl.style.width = w + 'px';
                wrapEl.style.height = h + 'px';
            }
        },
        addListener(ev, fn) {
            const e = ev === 'click' ? 'gmp-click' : ev;
            if (e === 'gmp-click') mk.gmpClickable = true;
            if (typeof mk.addEventListener === 'function') {
                mk.addEventListener(e, fn);
                return { remove: () => mk.removeEventListener(e, fn) };
            }
            return mk.addListener(e, fn);
        },
    };
    if (mapRef && iconVariant) registrarMarcadorCarro(mapRef, api);
    return api;
}

// Rotas via Route.computeRoutes (Routes API). Sem DirectionsService legado.
function criarRotaControle(map, polylineOptions = {}) {
    const estilo = { strokeColor: '#000000', strokeWeight: 6, strokeOpacity: 0.95, ...polylineOptions };
    let polylines = [];

    function desenharLinha(pontos) {
        if (!map || !pontos?.length) return;
        const pl = new google.maps.Polyline({ path: pontos, map, ...estilo });
        polylines.push(pl);
    }

    const ctrl = {
        async calcular(origem, destino) {
            ctrl.limpar();
            const o = normalizarLatLng(origem);
            const d = normalizarLatLng(destino);
            if (!o || !d) throw new Error('coordenadas inválidas');
            if (!_RouteClass) await carregarMaps();

            try {
                const { routes } = await _RouteClass.computeRoutes({
                    origin: o,
                    destination: d,
                    travelMode: 'DRIVING',
                    fields: ['path', 'distanceMeters', 'durationMillis', 'localizedValues', 'legs'],
                });
                if (!routes?.length) throw new Error('sem rota');
                const route = routes[0];
                if (map) {
                    polylines = route.createPolylines() || [];
                    if (!polylines.length && route.path?.length) {
                        desenharLinha(route.path);
                    } else {
                        polylines.forEach((pl) => {
                            if (pl.setOptions) pl.setOptions(estilo);
                            pl.setMap(map);
                        });
                    }
                }
                return respostaRotaLegada(route);
            } catch (err) {
                console.warn('Route.computeRoutes indisponível — linha reta:', err?.message || err);
                const resp = respostaRotaFallback(o, d);
                if (map && resp._fallbackLine) desenharLinha(resp._fallbackLine);
                return resp;
            }
        },
        limpar() {
            polylines.forEach((pl) => pl.setMap(null));
            polylines = [];
        },
        setMap(m) {
            if (!m) ctrl.limpar();
        },
        setDirections(resp) {
            if (!map) return;
            ctrl.limpar();
            if (resp?._route) {
                polylines = resp._route.createPolylines() || [];
                polylines.forEach((pl) => {
                    if (pl.setOptions) pl.setOptions(estilo);
                    pl.setMap(map);
                });
            } else if (resp?._fallbackLine) {
                desenharLinha(resp._fallbackLine);
            }
        },
    };
    return ctrl;
}

// Autocomplete moderno (PlaceAutocompleteElement) no lugar do input legado.
async function ligarPlaceAutocomplete(inputEl, { map, onPlace, onFocus } = {}) {
    const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
    const wrap = document.createElement('div');
    wrap.className = 'map-search-wrap';
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);

    const pac = new PlaceAutocompleteElement({});
    pac.placeholder = inputEl.placeholder || '';
    pac.className = 'map-search-float';
    inputEl.style.display = 'none';
    wrap.appendChild(pac);

    function compactarVisualAutocomplete(tentativas = 0) {
        const root = pac.shadowRoot;
        if (root && !root.getElementById('vap-compact-place-style')) {
            const style = document.createElement('style');
            style.id = 'vap-compact-place-style';
            style.textContent = `
                :host {
                    height: 46px !important;
                    min-height: 0 !important;
                }
                * {
                    box-sizing: border-box !important;
                }
                input,
                [role="combobox"] {
                    height: 44px !important;
                    min-height: 0 !important;
                    line-height: 44px !important;
                    padding-top: 0 !important;
                    padding-bottom: 0 !important;
                }
                div,
                label {
                    min-height: 0 !important;
                }
            `;
            root.appendChild(style);
            return;
        }
        if (!root && tentativas < 20) {
            requestAnimationFrame(() => compactarVisualAutocomplete(tentativas + 1));
        }
    }
    requestAnimationFrame(() => compactarVisualAutocomplete());

    const fecharTeclado = () => {
        try { pac.blur(); } catch (_) {}
        const interno = pac.shadowRoot?.querySelector('input, [role="combobox"]');
        if (interno) try { interno.blur(); } catch (_) {}
        if (document.activeElement && document.activeElement !== document.body) {
            try { document.activeElement.blur(); } catch (_) {}
        }
    };

    if (map) {
        const atualizarBias = () => {
            const b = map.getBounds();
            if (b) pac.locationBias = b;
        };
        atualizarBias();
        map.addListener('bounds_changed', atualizarBias);
    }
    pac.addEventListener('focus', () => { if (onFocus) onFocus(); }, true);
    pac.addEventListener('gmp-select', async ({ placePrediction }) => {
        try {
            const place = placePrediction.toPlace();
            await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
            if (!place.location) return;
            onPlace({
                name: place.displayName,
                formatted_address: place.formattedAddress,
                geometry: { location: posicaoLegada({ position: place.location }) },
            });
            pac.value = '';
            fecharTeclado();
        } catch (_) { /* seleção inválida */ }
    });
    return pac;
}

// Mesma fonte do buscador do mapa (Place.searchByText + viés do mapa).
async function buscarLugarGoogle(textQuery, { map, locationBias, nomePreferido } = {}) {
    if (!textQuery) return null;
    const { Place } = await google.maps.importLibrary('places');
    const bias = locationBias || map?.getBounds?.() || null;
    const req = {
        textQuery: String(textQuery),
        fields: ['displayName', 'formattedAddress', 'location'],
        maxResultCount: 8,
        language: 'pt-BR',
        region: 'br',
    };
    if (bias) req.locationBias = bias;
    const { places } = await Place.searchByText(req);
    if (!places?.length) return null;

    const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[—–()-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    let escolhido = places[0];
    if (nomePreferido) {
        // Nome exigido: só aceita resultado cujo nome bata, senão devolve null
        // (o chamador usa a coordenada curada). Evita cair no ponto genérico da mina.
        const alvo = norm(nomePreferido);
        const stop = new Set(['s11d', 'usina', 'mina', 'serra', 'sul', 'complexo', 'vale', 'de', 'do', 'da', 'e']);
        const palavras = alvo.split(' ').filter((w) => w.length > 2 && !stop.has(w));
        const combina = (dn) => {
            if (!dn) return false;
            if (dn === alvo || dn.includes(alvo) || alvo.includes(dn)) return true;
            if (!palavras.length) return false;
            const hits = palavras.filter((w) => dn.includes(w)).length;
            return hits / palavras.length >= 0.6;
        };
        escolhido = places.find((p) => combina(norm(p.displayName))) || null;
        if (!escolhido) return null;
    }

    // searchByText já traz os fields pedidos; só busca de novo se location faltar.
    if (!escolhido.location) {
        try { await escolhido.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] }); }
        catch (_) { /* mantém o que veio */ }
    }
    if (!escolhido.location) return null;
    const loc = escolhido.location;
    const lat = typeof loc.lat === 'function' ? loc.lat() : loc.lat;
    const lng = typeof loc.lng === 'function' ? loc.lng() : loc.lng;
    return {
        lat: Number(lat),
        lng: Number(lng),
        nome: nomePreferido || escolhido.displayName || textQuery,
        formatted_address: escolhido.formattedAddress,
    };
}

/* -------------------- Geolocalização -------------------- */
function obterLocalizacao(opts = {}) {
    const pedir = (o) => new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Geolocalização indisponível'));
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            (err) => reject(err),
            o
        );
    });
    // 1ª tentativa precisa. Se falhar por timeout/indisponível (comum no iPhone),
    // tenta de novo aceitando posição aproximada/cacheada — no iOS a segunda
    // tentativa "grossa" costuma responder. Permissão negada (code 1) não
    // re-tenta: só resolve liberando a localização nos ajustes.
    return pedir({ enableHighAccuracy: true, timeout: 12000, maximumAge: 0, ...opts })
        .catch((err) => {
            if (err && err.code === 1) throw err;
            return pedir({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60000, ...opts });
        })
        .then((p) => {
            // Guarda a última posição: o mapa abre NA HORA centrado nela na
            // próxima vez, sem esperar o GPS responder de novo.
            try { localStorage.setItem('ultimaPos', JSON.stringify({ ...p, em: Date.now() })); } catch (_) {}
            return p;
        });
}

// GPS com teto curto na captura de foto — não segura selfie/upload esperando 12s+.
function obterLocalizacaoRapida() {
    const fallback = () => ultimaPosConhecida() || { lat: null, lng: null };
    if (!navigator.geolocation) return Promise.resolve(fallback());
    return Promise.race([
        obterLocalizacao({ enableHighAccuracy: false, timeout: 3500, maximumAge: 180000 }),
        new Promise((r) => setTimeout(() => r(fallback()), 3800)),
    ]).catch(() => fallback());
}

// Última posição conhecida (para abrir o mapa instantaneamente). Vale por 7 dias.
function ultimaPosConhecida() {
    try {
        const p = JSON.parse(localStorage.getItem('ultimaPos') || 'null');
        if (p && p.lat && Date.now() - (p.em || 0) < 7 * 24 * 3600 * 1000) return { lat: p.lat, lng: p.lng };
    } catch (_) {}
    return null;
}

/* -------------------- Câmera (captura AO VIVO, sem anexar arquivo) -------------------- */
/*
   capturarFoto({ tipo: 'selfies'|'carros', facing: 'user'|'environment', ocrPlaca: bool, titulo })
   -> resolve { url, lat, lng, em, placa? }  (placa só quando ocrPlaca = true)
*/
function capturarFoto(opts = {}) {
    const { tipo = 'outros', facing = 'environment', ocrPlaca = false, titulo = 'Tirar foto', hint } = opts;
    const hintPadrao = ocrPlaca
        ? 'Enquadre a placa dianteira do veículo'
        : 'Posicione o rosto e capture';
    const hintTexto = hint || hintPadrao;

    return new Promise((resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.className = 'cam-overlay cam-live';
        overlay.innerHTML = `
            <div class="cam-box">
                <h3>${titulo}</h3>
                <div class="cam-video-wrap">
                    <video class="cam-video ${facing === 'user' ? 'cam-video-espelho' : ''}" autoplay playsinline muted></video>
                    <p class="cam-hint">${hintTexto} • só câmera ao vivo (galeria bloqueada)</p>
                </div>
                <div class="cam-status"></div>
                <div class="cam-actions">
                    <button type="button" class="btn btn-secondary cam-cancel">Cancelar</button>
                    <button type="button" class="btn btn-primary cam-shot"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Capturar</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const video = overlay.querySelector('.cam-video');
        const status = overlay.querySelector('.cam-status');
        const btnShot = overlay.querySelector('.cam-shot');
        let stream = null;

        const encerrar = () => {
            if (stream) stream.getTracks().forEach((t) => t.stop());
            overlay.remove();
        };
        overlay.querySelector('.cam-cancel').onclick = () => { encerrar(); reject(new Error('cancelado')); };

        // Pipeline: redimensiona, carimba GPS/hora, OCR (placa) e upload em paralelo.
        async function processarEnviar(fonte, w, h) {
            const maxDim = tipo === 'selfies' ? 720 : (ocrPlaca ? 1280 : 960);
            const qualidade = tipo === 'selfies' ? 0.72 : 0.8;
            const canvas = document.createElement('canvas');
            const escala = Math.min(1, maxDim / Math.max(w, h));
            canvas.width = Math.round(w * escala);
            canvas.height = Math.round(h * escala);
            canvas.getContext('2d').drawImage(fonte, 0, 0, canvas.width, canvas.height);

            status.textContent = ocrPlaca ? 'Enviando e lendo placa...' : 'Enviando foto...';

            const locPromise = obterLocalizacaoRapida();
            const blobPromise = new Promise((r) => canvas.toBlob(r, 'image/jpeg', qualidade));
            const ocrPromise = ocrPlaca ? lerPlaca(canvas) : Promise.resolve(null);

            const uploadPromise = blobPromise.then(async (blob) => {
                const emUpload = new Date().toISOString();
                const fd = new FormData();
                fd.append('foto', blob, `${tipo}.jpg`);
                fd.append('tipo', tipo);
                fd.append('capturado_em', emUpload);
                fd.append('origem', 'camera');
                const resp = await fetchWithAuth('/api/fotos', { method: 'POST', body: fd });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'Falha no upload');
                return { url: data.url, em: emUpload };
            });

            const [upload, placa, loc] = await Promise.all([uploadPromise, ocrPromise, locPromise]);

            encerrar();
            resolve({ url: upload.url, lat: loc.lat, lng: loc.lng, em: upload.em, placa });
        }

        const falhaCamera = (motivo) => {
            encerrar();
            reject(new Error(motivo || 'Não foi possível abrir a câmera. Libere o acesso nas configurações do navegador. Só é permitida foto ao vivo — não é possível anexar da galeria.'));
        };

        btnShot.onclick = async () => {
            try {
                status.textContent = 'Processando...';
                if (!video.videoWidth) {
                    await new Promise((ok) => {
                        video.addEventListener('loadedmetadata', ok, { once: true });
                        setTimeout(ok, 2000);
                    });
                }
                if (!video.videoWidth) {
                    return falhaCamera('A câmera não iniciou. Feche e abra de novo, ou libere o acesso à câmera.');
                }
                await processarEnviar(video, video.videoWidth, video.videoHeight);
            } catch (e) {
                status.textContent = 'Erro: ' + e.message;
            }
        };

        async function iniciarCamera() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                return falhaCamera('Câmera ao vivo indisponível neste navegador.');
            }
            const tentativas = [
                { video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 960 } }, audio: false },
                { video: { facingMode: facing }, audio: false },
                { video: true, audio: false },
            ];
            for (const opts of tentativas) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia(opts);
                    video.srcObject = stream;
                    const p = video.play();
                    if (p && p.catch) p.catch(() => {});
                    return;
                } catch (_) { /* próxima tentativa */ }
            }
            falhaCamera();
        }

        iniciarCamera();
    });
}

/* -------------------- OCR de placa (Tesseract.js) -------------------- */
const _TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let _ocrWorkerPromise = null;

function preCarregarOcr() {
    if (!_ocrWorkerPromise) {
        _ocrWorkerPromise = (async () => {
            await carregarScript(_TESSERACT_SRC);
            const worker = await Tesseract.createWorker('eng', 1, {
                logger: () => {},
            });
            await worker.setParameters({
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                tessedit_pageseg_mode: '7',
            });
            return worker;
        })();
        _ocrWorkerPromise.catch(() => { _ocrWorkerPromise = null; });
    }
    return _ocrWorkerPromise;
}

function canvasRecortePlaca(src) {
    const w = src.width;
    const h = src.height;
    const cw = Math.round(w * 0.9);
    const ch = Math.round(h * 0.34);
    const sx = Math.round((w - cw) / 2);
    const sy = Math.max(0, h - ch - Math.round(h * 0.06));
    const ocrMax = 520;
    const scale = Math.min(1, ocrMax / cw);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw * scale));
    out.height = Math.max(1, Math.round(ch * scale));
    const ctx = out.getContext('2d');
    ctx.drawImage(src, sx, sy, cw, ch, 0, 0, out.width, out.height);
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = g > 155 ? 255 : g < 85 ? 0 : g;
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return out;
}

function extrairPlacaTexto(texto) {
    const limpo = (texto || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = limpo.match(/[A-Z]{3}[0-9][A-Z0-9][0-9]{2}/);
    return m ? m[0] : null;
}

async function lerPlaca(canvas) {
    try {
        const worker = await preCarregarOcr();
        const crop = canvasRecortePlaca(canvas);
        const { data } = await worker.recognize(crop);
        return extrairPlacaTexto(data.text);
    } catch (e) {
        console.warn('OCR falhou:', e.message);
        return null;
    }
}

/* -------------------- Utilidades -------------------- */
// Escapa texto vindo do usuário antes de interpolar em innerHTML/atributos.
// Sem isso, um nome/observação/tag como "<img onerror=...>" executaria script
// no navegador de OUTRO usuário (XSS armazenado → roubo do token no localStorage).
// Use SEMPRE que jogar dado de usuário numa template string de HTML.
function escapeHtml(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// Alias curto para deixar as templates legíveis.
const esc = escapeHtml;

function normalizarTelefoneWhatsApp(telefone) {
    if (!telefone) return null;
    let n = String(telefone).replace(/\D/g, '');
    if (n.length <= 11) n = '55' + n;
    return n;
}

function linkWhatsApp(telefone) {
    const n = normalizarTelefoneWhatsApp(telefone);
    return n ? `https://wa.me/${n}` : null;
}

// Abre o WhatsApp direto no app (evita a página intermediária api.whatsapp.com no
// celular). Se o esquema whatsapp:// não abrir — sem WhatsApp instalado ou bloqueado
// num PWA em modo standalone — cai automaticamente para o link wa.me em nova aba,
// para o botão NUNCA ficar sem efeito.
function abrirWhatsApp(telefone, texto) {
    const n = normalizarTelefoneWhatsApp(telefone);
    if (!n) return false;
    const msg = texto != null ? String(texto) : '';
    const waWeb = `https://wa.me/${n}` + (msg ? `?text=${encodeURIComponent(msg)}` : '');
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (mobile) {
        const appUrl = `whatsapp://send?phone=${n}` + (msg ? `&text=${encodeURIComponent(msg)}` : '');
        let abriu = false;
        const cancelar = () => { abriu = true; };
        // O app abrindo tira o foco da página (fica oculta): isso cancela o fallback.
        document.addEventListener('visibilitychange', cancelar, { once: true });
        window.addEventListener('pagehide', cancelar, { once: true });
        setTimeout(() => {
            document.removeEventListener('visibilitychange', cancelar);
            window.removeEventListener('pagehide', cancelar);
            if (!abriu) window.open(waWeb, '_blank', 'noopener');   // esquema não abriu: usa wa.me
        }, 1200);
        window.location.href = appUrl;
    } else {
        window.open(waWeb, '_blank', 'noopener');
    }
    return true;
}

function fmtData(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR');
}

function fmtHorario(h) {
    return h ? new Date(h).toLocaleString('pt-BR') : 'Agora (tempo real)';
}
