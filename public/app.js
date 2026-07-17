/* ============================================================
   VAP - utilidades globais (auth, mapa, câmera, OCR)
   ============================================================ */

// Saudação por horário ("Boa noite," em cima, nome embaixo — estilo app de corrida).
function aplicarSaudacaoUsuario(el, nome) {
    if (!el || !nome) return;
    const h = new Date().getHours();
    const saud = h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
    el.innerHTML = '';
    const s = document.createElement('small');
    s.textContent = saud + ',';
    const b = document.createElement('strong');
    b.textContent = String(nome).split(' ')[0];
    el.appendChild(s);
    el.appendChild(b);
}

// adminOnly: exige is_admin.
// opts.superOnly: só dono/super admin (matrículas SUPER_ADMIN no servidor; no
//   client usamos flag user.super_admin se existir, senão heurística 000000/900000
//   e redireciona admin de canteiro para opts.redirectAdmin || admin.html).
// opts.redirectAdmin: destino se superOnly falhar.
function checkAuth(adminOnly = false, opts = {}) {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (!token || !user) { location.href = 'index.html'; return; }
    if (adminOnly && !user.is_admin) {
        avisoProximaPagina('Acesso restrito a administradores.');
        location.href = 'dashboard.html';
        return;
    }
    if (opts.superOnly) {
        const ehDono = user.super_admin === true
            || ['000000', '900000'].includes(String(user.matricula || ''));
        if (!ehDono) {
            avisoProximaPagina('Acesso restrito ao dono da empresa.');
            location.href = opts.redirectAdmin || 'admin.html';
            return;
        }
    }
    aplicarSaudacaoUsuario(document.getElementById('userName'), user.nome);
    // Sessão é global por navegador (token no localStorage). Se outra aba logar com
    // outro usuário, o token daqui é trocado sem aviso e a tela passaria a agir como
    // o usuário errado. Detecta a troca em outra aba e recarrega em vez de continuar.
    instalarAvisoTrocaSessao(user);
    // LGPD: quem se cadastrou antes do consentimento precisa aceitar a política
    // para continuar usando o app. Verifica no servidor e, se pendente, mostra o
    // portão bloqueante. Fire-and-forget (não trava o resto do carregamento).
    verificarConsentimentoLGPD();
}

/** True se a matrícula está na lista de dono (espelha SUPER_ADMIN_MATRICULAS padrão). */
function ehDonoEmpresa(user) {
    if (!user || !user.is_admin) return false;
    if (user.super_admin === true) return true;
    return ['000000', '900000'].includes(String(user.matricula || ''));
}

// O evento 'storage' dispara SÓ nas OUTRAS abas do mesmo navegador — exatamente a
// aba que teve a sessão substituída. Se o usuário logado mudou (ou saiu), avisa e
// recarrega para refletir a sessão real (evita motorista/passageiro cruzados).
function instalarAvisoTrocaSessao(usuarioAtual) {
    if (window._avisoSessaoInstalado) return;
    window._avisoSessaoInstalado = true;
    const idAtual = usuarioAtual && usuarioAtual.id != null ? usuarioAtual.id : null;
    window.addEventListener('storage', (e) => {
        if (e.key !== null && e.key !== 'user' && e.key !== 'token') return;
        const token = localStorage.getItem('token');
        let novo = null;
        try { novo = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) {}
        const idNovo = novo && novo.id != null ? novo.id : null;
        if (idNovo === idAtual && token) return;   // mesma sessão: nada a fazer
        alert(!token
            ? 'Você saiu da conta em outra aba deste navegador. A página vai recarregar.'
            : 'A sessão foi trocada em outra aba deste navegador (agora: '
              + ((novo && novo.nome) || 'outro usuário') + '). A página vai recarregar.');
        location.reload();
    });
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
    gate.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(35,33,28,.45);' +
        'display:flex;align-items:center;justify-content:center;padding:20px;';
    gate.innerHTML = `
        <div style="max-width:440px;width:100%;background:#ffffff;border:1px solid #ece8df;
                    border-radius:16px;padding:24px 22px;color:#23211c;font-family:inherit;
                    box-shadow:0 20px 60px rgba(20,18,12,.25);">
            <h2 style="color:#23211c;margin:0 0 10px;font-size:1.25rem;font-weight:600;">Atualização de privacidade</h2>
            <p style="line-height:1.6;margin:0 0 12px;color:#3a382f;">
                Para continuar usando o VAP, precisamos do seu aceite da
                <a href="politica-privacidade.html" target="_blank" rel="noopener" style="color:#b0562f;font-weight:600;">Política de Privacidade</a>.
                Ela explica como usamos sua selfie, foto do veículo e localização (GPS)
                para a segurança das caronas, conforme a LGPD.
            </p>
            <div id="lgpdGateMsg" style="display:none;color:#c0392b;font-size:.9rem;margin-bottom:10px;"></div>
            <button id="lgpdAceitar" type="button"
                style="width:100%;padding:13px;border:none;border-radius:11px;background:#EAD298;color:#23211c;
                       font-weight:700;font-size:1rem;cursor:pointer;">Li e aceito a Política de Privacidade</button>
            <button id="lgpdSair" type="button"
                style="width:100%;padding:11px;margin-top:10px;border:1px solid #ece8df;border-radius:11px;
                       background:#fff;color:#6b675f;font-size:.92rem;cursor:pointer;">Agora não (sair)</button>
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

    // platform.js já patcha fetch(/api) no nativo com bundle local; apiUrl reforça.
    const finalUrl = (window.VapPlatform && VapPlatform.apiUrl) ? VapPlatform.apiUrl(url) : url;
    const resp = await fetch(finalUrl, { ...options, headers, credentials: 'include' });
    if (resp.status === 401) {
        let msg401 = 'Sessão expirada. Entre novamente.';
        try {
            const d = await resp.clone().json();
            if (d && d.error) msg401 = d.error;
        } catch (_) {}
        avisoProximaPagina(msg401);
        logout();
    }
    return resp;
}

/* -------------------- Notificações push (Web Push PWA | FCM nativo) -------------------- */
function _b64ToUint8(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
// Inscreve o aparelho para receber notificações. Idempotente e à prova de erro.
// Nativo: @capacitor/push-notifications → token FCM/APNs.
// PWA: Service Worker + Web Push (VAPID) — caminho original intacto.
let _pushPronto = false;
async function registrarPushNativo() {
    const Push = window.VapPlatform && VapPlatform.plugin
        ? VapPlatform.plugin('PushNotifications')
        : (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.PushNotifications);
    if (!Push) return false;
    try {
        let perm = await Push.checkPermissions();
        if (perm.receive !== 'granted') {
            perm = await Push.requestPermissions();
        }
        if (perm.receive !== 'granted') return false;

        await Push.register();

        // Evita listeners duplicados em reentradas.
        if (!registrarPushNativo._bound) {
            registrarPushNativo._bound = true;
            await Push.addListener('registration', async (token) => {
                try {
                    const value = token && (token.value || token);
                    if (!value) return;
                    const platform = (window.Capacitor && Capacitor.getPlatform && Capacitor.getPlatform()) || 'android';
                    const r = await fetchWithAuth('/api/push/device-token', {
                        method: 'POST',
                        body: JSON.stringify({ token: value, platform }),
                    });
                    if (r && r.ok) _pushPronto = true;
                } catch (_) {}
            });
            await Push.addListener('registrationError', (err) => {
                console.warn('Push nativo registrationError:', err);
            });
            await Push.addListener('pushNotificationActionPerformed', (ev) => {
                try {
                    const data = (ev && ev.notification && ev.notification.data) || {};
                    const url = data.url || '/dashboard.html';
                    if (url && !String(location.href).includes(String(url).replace(/^\//, ''))) {
                        location.href = url;
                    }
                } catch (_) {}
            });
        }
        return true;
    } catch (e) {
        console.warn('registrarPushNativo:', e && e.message);
        return false;
    }
}

async function registrarPushWeb(silencioso) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
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
}

async function registrarPush(silencioso = false) {
    try {
        if (_pushPronto) return;
        if (!localStorage.getItem('token')) return;

        const nativo = window.VapPlatform && VapPlatform.isNative && VapPlatform.isNative();
        if (nativo) {
            const ok = await registrarPushNativo();
            if (ok) return;
            // Sem plugin/Firebase ainda: não cai no Web Push (SW no Cap nativo é frágil).
            return;
        }
        await registrarPushWeb(silencioso);
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
let _RenderingType = null; // preenchido em carregarMaps() via importLibrary('maps')

// VECTOR chama GetViewportInfo → 502/CORS/QUIC intermitente no Maps.
// SEMPRE RASTER (enum da lib ou string). Nunca deixar o default VECTOR.
function renderingTypeRaster() {
    const RT = _RenderingType
        || window.google?.maps?.RenderingType
        || null;
    if (RT && RT.RASTER != null) return RT.RASTER;
    return 'RASTER';
}

function _ehRasterAtual(map, rt) {
    try {
        if (typeof map.getRenderingType !== 'function') return true;
        const atual = map.getRenderingType();
        return atual === rt || atual === 'RASTER'
            || String(atual || '').toUpperCase().includes('RASTER');
    } catch (_) {
        return false;
    }
}

/** Aplica RASTER uma vez (sem loop pesado — em rede lenta o setInterval joga FPS no chão). */
function forcarMapaRaster(map) {
    if (!map) return;
    const rt = renderingTypeRaster();
    try {
        if (typeof map.setRenderingType === 'function') map.setRenderingType(rt);
    } catch (_) { /* API antiga */ }
    try {
        map.setOptions({ renderingType: rt });
    } catch (_) { /* ignora */ }
    if (!_ehRasterAtual(map, rt)) {
        requestAnimationFrame(() => {
            try {
                if (typeof map.setRenderingType === 'function') map.setRenderingType(renderingTypeRaster());
                map.setOptions({ renderingType: renderingTypeRaster() });
            } catch (_) { /* ignora */ }
        });
    }
}

// Cache do /api/config — evita N fetches em retry
let _mapsConfigCache = null;
async function obterConfigMaps() {
    if (_mapsConfigCache?.mapsApiKey) return _mapsConfigCache;
    const cfg = await (await fetch('/api/config')).json();
    _mapsConfigCache = cfg;
    return cfg;
}

// Map ID real (Cloud) → estilo na nuvem + Advanced Markers.
// DEMO_MAP_ID → sem mapId no Map, para ESTILO_MAPA_CLARO (mapa branco) no cliente.
// Advanced Markers exigem mapId; no DEMO usamos OverlayView HTML (criarMarcador).
// Em rede frágil, mapId costuma forçar VECTOR/GetViewportInfo — se falhar, o
// criador do mapa pode recriar sem mapId (ver novoMapa).
function mapaIdEfetivo() {
    if (!_mapId || _mapId === 'DEMO_MAP_ID') return null;
    return _mapId;
}

function opcoesMapa(opts = {}) {
    const o = { ...opts };
    const semMapId = !!o._semMapId;
    delete o._semMapId;
    const mid = semMapId ? null : mapaIdEfetivo();
    if (mid) o.mapId = mid;
    else delete o.mapId;
    // Sempre RASTER — nunca VECTOR (GetViewportInfo 502/QUIC).
    o.renderingType = renderingTypeRaster();
    // Evita extras que disparam RPC extra no load
    if (o.isFractionalZoomEnabled == null) o.isFractionalZoomEnabled = false;
    return o;
}

function _sleepMaps(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
        _path: [o, d],
        _durationMillis: min * 60000,
        km: Math.round(distKm * 100) / 100,
    };
}

/** Rota pela pista via servidor (Routes REST) — evita falha do Route.computeRoutes no browser. */
async function calcularRotaServidor(o, d) {
    const r = await fetchWithAuth('/api/rotas', {
        method: 'POST',
        body: JSON.stringify({
            origin_lat: o.lat, origin_lng: o.lng,
            dest_lat: d.lat, dest_lng: d.lng,
        }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.path?.length) {
        throw new Error(j?.error || `rota servidor HTTP ${r.status}`);
    }
    const distText = formatarMetros(j.distanceMeters);
    const durText = formatarDuracaoMs(j.durationMillis);
    return {
        routes: [{ legs: [{ distance: { text: distText }, duration: { text: durText }, steps: [] }] }],
        _fallbackLine: j.path,
        _path: j.path,
        _durationMillis: j.durationMillis || 0,
        km: j.km != null ? j.km : Math.round(((j.distanceMeters || 0) / 1000) * 100) / 100,
    };
}

/* -------- Economia Google Routes: acompanhar a rota SEM recalcular --------
   A rota é calculada uma vez; enquanto o GPS seguir em cima da polyline, o
   progresso (km restantes, ETA) é derivado localmente por projeção do ponto na
   linha. Só um desvio real (sair da rota) justifica nova chamada paga. */

// Distância (km) de um ponto p ao segmento a-b, em projeção plana local
// (suficiente para decidir "está na rota?" em escala urbana).
function distKmPontoSegmento(p, a, b) {
    const kmLat = 111.32;
    const kmLng = 111.32 * Math.cos((p.lat * Math.PI) / 180);
    const ax = (a.lng - p.lng) * kmLng, ay = (a.lat - p.lat) * kmLat;
    const bx = (b.lng - p.lng) * kmLng, by = (b.lat - p.lat) * kmLat;
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (-ax * abx - ay * aby) / len2)) : 0;
    const cx = ax + abx * t, cy = ay + aby * t;
    return Math.sqrt(cx * cx + cy * cy);
}

// Projeta a posição na rota: {distKm: afastamento da linha, kmRestante: da
// projeção até o fim}. null se a rota não tem pelo menos 2 pontos.
function progressoNaRota(pos, path) {
    if (!pos || !Array.isArray(path) || path.length < 2) return null;
    let melhor = { distKm: Infinity, seg: 0 };
    for (let i = 1; i < path.length; i++) {
        const d = distKmPontoSegmento(pos, path[i - 1], path[i]);
        if (d < melhor.distKm) melhor = { distKm: d, seg: i };
    }
    let kmRestante = haversineKmApp(pos.lat, pos.lng, path[melhor.seg].lat, path[melhor.seg].lng);
    for (let i = melhor.seg + 1; i < path.length; i++) {
        kmRestante += haversineKmApp(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
    }
    return { distKm: melhor.distKm, kmRestante: Math.round(kmRestante * 100) / 100 };
}

// Saiu da rota? (afastamento acima do corredor de ~80 m)
const FORA_DA_ROTA_KM = 0.08;
function foraDaRota(pos, path) {
    const p = progressoNaRota(pos, path);
    return !p || p.distKm > FORA_DA_ROTA_KM;
}

/**
 * Bootstrap do Maps com timeout + retry.
 * Rede fraca/QUIC costuma derrubar o 1º script; o 2º/3º costuma passar.
 */
function instalarMapsBootstrap(apiKey) {
    if (window.google?.maps?.importLibrary) return Promise.resolve(window.google);
    if (window.__vapMapsBootstrap) return window.__vapMapsBootstrap;

    const carregarScript = (tentativa) => new Promise((resolve, reject) => {
        try {
            // Remove script morto de tentativas anteriores
            document.querySelectorAll('script[data-vap-maps-boot]').forEach((s) => {
                try { s.remove(); } catch (_) {}
            });
            // Limpa estado parcial do loader
            try {
                if (window.google && !window.google.maps?.importLibrary) {
                    delete window.google.maps;
                }
            } catch (_) {}

            const g = {
                key: apiKey,
                // quarterly = estável; GetViewportInfo some menos que weekly
                v: 'quarterly',
                // Best practice Google: evita warning "loaded without loading=async"
                loading: 'async',
            };
            const c = 'google';
            const l = 'importLibrary';
            const q = '__ib__' + (tentativa || 0);
            const m = document;
            const b = window;
            b[c] = b[c] || {};
            const d = b[c].maps = b[c].maps || {};
            const r = new Set();
            const e = new URLSearchParams();
            let h = null;
            const u = () => h || (h = new Promise(async (f, n) => {
                const a = m.createElement('script');
                a.setAttribute('data-vap-maps-boot', '1');
                a.async = true;
                a.defer = true;
                e.set('libraries', [...r] + '');
                for (const k in g) {
                    e.set(k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()), g[k]);
                }
                e.set('callback', c + '.maps.' + q);
                // cache-bust por tentativa (evita script quebrado em cache intermediário)
                if (tentativa > 0) e.set('_vap', String(Date.now()));
                a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
                const tmo = setTimeout(() => {
                    n(new Error('Maps bootstrap timeout'));
                }, 14000);
                d[q] = () => { clearTimeout(tmo); f(); };
                a.onerror = () => {
                    clearTimeout(tmo);
                    n(new Error('Maps script onerror'));
                };
                a.nonce = m.querySelector('script[nonce]')?.nonce || '';
                m.head.append(a);
            }));
            d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n));
            u().then(() => resolve(window.google)).catch(reject);
        } catch (err) {
            reject(err);
        }
    });

    window.__vapMapsBootstrap = (async () => {
        let lastErr = null;
        // 2 tentativas (3× em rede lenta = 40s+ de espera e parece “travado”)
        for (let t = 0; t < 2; t++) {
            try {
                if (window.google?.maps?.importLibrary) return window.google;
                await carregarScript(t);
                await Promise.race([
                    window.google.maps.importLibrary('maps'),
                    _sleepMaps(10000).then(() => { throw new Error('importLibrary maps timeout'); }),
                ]);
                return window.google;
            } catch (err) {
                lastErr = err;
                console.warn('Maps bootstrap tentativa', t + 1, err?.message || err);
                try { delete window.google?.maps?.[('__ib__' + t)]; } catch (_) {}
                await _sleepMaps(400 * (t + 1));
            }
        }
        window.__vapMapsBootstrap = null;
        throw lastErr || new Error('Maps bootstrap falhou');
    })();

    return window.__vapMapsBootstrap;
}

async function _importLibComTimeout(nome, ms = 10000) {
    return Promise.race([
        google.maps.importLibrary(nome),
        _sleepMaps(ms).then(() => { throw new Error('timeout importLibrary ' + nome); }),
    ]);
}

/** routes/places em background — mapa e carro não precisam esperar. */
function _carregarLibsExtrasEmFundo() {
    if (window.__vapMapsExtrasPromise) return window.__vapMapsExtrasPromise;
    window.__vapMapsExtrasPromise = (async () => {
        try {
            const routesLib = await _importLibComTimeout('routes', 12000);
            if (routesLib?.Route) _RouteClass = routesLib.Route;
        } catch (e) {
            console.warn('routes lib (fundo):', e?.message || e);
        }
        try {
            await _importLibComTimeout('places', 12000);
        } catch (e) {
            console.warn('places lib (fundo):', e?.message || e);
        }
    })();
    return window.__vapMapsExtrasPromise;
}

async function garantirPlacesLib() {
    if (window.google?.maps?.importLibrary) {
        try {
            await _importLibComTimeout('places', 12000);
        } catch (_) { /* autocomplete tenta depois */ }
    }
}

async function carregarMapsOnce() {
    const cfg = await obterConfigMaps();
    if (!cfg.mapsApiKey) throw new Error('Google Maps API key não configurada (.env GOOGLE_MAPS_API_KEY)');
    _mapId = cfg.mapsMapId || 'DEMO_MAP_ID';
    await instalarMapsBootstrap(cfg.mapsApiKey);

    // Caminho rápido: só maps + marker (abre mapa/carro). routes/places em paralelo depois.
    let mapsLib;
    let markerLib;
    try {
        [mapsLib, markerLib] = await Promise.all([
            _importLibComTimeout('maps', 10000),
            _importLibComTimeout('marker', 10000),
        ]);
    } catch (_) {
        mapsLib = await _importLibComTimeout('maps', 12000);
        markerLib = await _importLibComTimeout('marker', 12000);
    }

    _RenderingType = mapsLib.RenderingType
        || mapsLib.Map?.RenderingType
        || window.google?.maps?.RenderingType
        || null;
    if (_RenderingType && !window.google.maps.RenderingType) {
        try { window.google.maps.RenderingType = _RenderingType; } catch (_) {}
    }
    _AdvancedMarkerElement = markerLib.AdvancedMarkerElement;
    _PinElement = markerLib.PinElement;

    // Não bloqueia o 1º paint do mapa
    _carregarLibsExtrasEmFundo();

    return window.google;
}

function carregarMaps() {
    if (_mapsPromise) return _mapsPromise;
    _mapsPromise = (async () => {
        let lastErr = null;
        for (let i = 0; i < 2; i++) {
            try {
                return await carregarMapsOnce();
            } catch (err) {
                lastErr = err;
                console.warn('carregarMaps tentativa', i + 1, err?.message || err);
                window.__vapMapsBootstrap = null;
                await _sleepMaps(500 * (i + 1));
            }
        }
        throw lastErr || new Error('Não foi possível carregar o Google Maps');
    })().catch((err) => {
        _mapsPromise = null;
        throw err;
    });
    return _mapsPromise;
}

// Pickup top-down em SVG puro (padrão do projeto). Frente = topo, gira com o rumo.
// Silhueta no estilo do carro clássico do app + proporções de Ranger (foto).
// Sem fundo branco: só paths transparentes.
function carSvgPaths(variant = 'gold') {
    const gid = 'vap-car-body-' + variant;
    const preta = variant === 'black' || variant === 'dark';
    const laranja = variant === 'laranja' || variant === 'orange';
    // Mostarda da foto / preto legado / laranja com preto (carona aceita)
    const body = preta ? '#2e333b' : laranja ? '#E8641B' : '#E4B429';
    const bodyEdge = preta ? '#0e1116' : laranja ? '#B84A0D' : '#C9921A';
    const stroke = preta ? '#000000' : laranja ? '#161616' : '#8A6A12';
    const glass = preta ? '#0c1015' : laranja ? '#121417' : '#2C2C2E';
    const glassSide = preta ? '#15181d' : laranja ? '#1b1e23' : '#3A3A3C';
    const roof = preta ? '#1e2023' : laranja ? '#D4560F' : '#D9A61F';
    const bed = preta ? '#12151a' : laranja ? '#101214' : '#1C1C1E';
    const detail = preta ? '#0a0c0f' : laranja ? '#8F3A08' : '#B88918';
    const tire = '#15181b';
    const mirror = preta ? '#15181d' : laranja ? '#141414' : '#1A1A1A';
    // Laranja: farol âmbar (sem branco) — "menos branco" no carro da viagem.
    const head = preta ? '#d8dde3' : laranja ? '#F2A93B' : '#F0F0F2';
    const grille = preta ? '#0a0c0f' : laranja ? '#141414' : '#2A2A2A';
    const tail = '#e03131';
    const shine = preta ? '0.08' : laranja ? '0.06' : '0.22';

    return `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">`
        + `<stop offset="0" stop-color="${bodyEdge}"/><stop offset="0.22" stop-color="${body}"/>`
        + `<stop offset="0.78" stop-color="${body}"/><stop offset="1" stop-color="${bodyEdge}"/>`
        + `</linearGradient></defs>`
        // pneus
        + `<rect x="7.6" y="11" width="3.2" height="8.5" rx="1.5" fill="${tire}"/>`
        + `<rect x="37.2" y="11" width="3.2" height="8.5" rx="1.5" fill="${tire}"/>`
        + `<rect x="7.6" y="46.5" width="3.2" height="8.5" rx="1.5" fill="${tire}"/>`
        + `<rect x="37.2" y="46.5" width="3.2" height="8.5" rx="1.5" fill="${tire}"/>`
        // carroceria (mesma família do SVG clássico do app)
        + `<path d="M24 2.6 C17.4 2.6 13.2 4.6 12 8.2 C11 11.2 10.6 14.4 10.5 18 L10.5 37.5 C10.5 39 10.9 40 11.8 40.8 L11.8 56.2 C11.8 59.4 14.4 61.6 17.8 61.7 L30.2 61.7 C33.6 61.6 36.2 59.4 36.2 56.2 L36.2 40.8 C37.1 40 37.5 39 37.5 37.5 L37.5 18 C37.4 14.4 37 11.2 36 8.2 C34.8 4.6 30.6 2.6 24 2.6 Z" fill="url(#${gid})" stroke="${stroke}" stroke-width="1.05"/>`
        // vincos do capô
        + `<path d="M15.2 5.6 C18.8 4 29.2 4 32.8 5.6" fill="none" stroke="${detail}" stroke-width="0.75" opacity="0.55"/>`
        + `<path d="M16.4 7.4 C19.6 6.1 28.4 6.1 31.6 7.4" fill="none" stroke="${detail}" stroke-width="0.55" opacity="0.4"/>`
        + `<path d="M24 4.8 L24 13.2" stroke="${detail}" stroke-width="0.7" opacity="0.4" stroke-linecap="round"/>`
        // grade + faróis
        + `<path d="M16.2 3.4 C19.2 2.7 28.8 2.7 31.8 3.4 L32.4 6.1 C28.6 5.4 19.4 5.4 15.6 6.1 Z" fill="${grille}"/>`
        + `<path d="M12.4 5.2 C13.7 4.1 15.6 3.7 16.9 3.9 L16.4 6.4 C15.1 6.1 13.6 6.4 12.7 7.2 Z" fill="${head}"/>`
        + `<path d="M35.6 5.2 C34.3 4.1 32.4 3.7 31.1 3.9 L31.6 6.4 C32.9 6.1 34.4 6.4 35.3 7.2 Z" fill="${head}"/>`
        + `<ellipse cx="24" cy="9.4" rx="7.2" ry="2" fill="#ffffff" opacity="${shine}"/>`
        // para-brisa
        + `<path d="M13.8 14.2 C17.6 12.1 30.4 12.1 34.2 14.2 L35 21.8 C28.4 20.2 19.6 20.2 13 21.8 Z" fill="${glass}"/>`
        + `<path d="M16.2 14.8 C19.2 13.5 24.4 13.3 27.4 14 L15.6 20.4 C15.1 19.5 15 18.2 15.3 17 Z" fill="#ffffff" opacity="${laranja ? '0.05' : '0.12'}"/>`
        // retrovisores
        + `<path d="M9.6 16.4 C7.7 15.7 6.5 16.5 6.8 17.9 C7.1 19.1 8.6 19.5 10.2 18.8 Z" fill="${mirror}"/>`
        + `<path d="M38.4 16.4 C40.3 15.7 41.5 16.5 41.2 17.9 C40.9 19.1 39.4 19.5 37.8 18.8 Z" fill="${mirror}"/>`
        // teto da cabine (amarelo / escuro — NÃO vidro inteiro)
        + `<path d="M13.4 22.6 C19.2 20.9 28.8 20.9 34.6 22.6 L33.8 34.8 C28.4 33.5 19.6 33.5 14.2 34.8 Z" fill="${roof}"/>`
        + `<ellipse cx="24" cy="26" rx="6.2" ry="1.5" fill="#ffffff" opacity="${(preta || laranja) ? '0.05' : '0.14'}"/>`
        // vidros laterais das portas
        + `<path d="M11.5 23.8 C12.4 23.3 13.3 23.2 14 23.5 L13.6 33.2 C12.8 33.6 11.9 33.7 11.3 33.3 Z" fill="${glassSide}"/>`
        + `<path d="M36.5 23.8 C35.6 23.3 34.7 23.2 34 23.5 L34.4 33.2 C35.2 33.6 36.1 33.7 36.7 33.3 Z" fill="${glassSide}"/>`
        // divisão cabine / caçamba
        + `<path d="M12.2 36.2 C18.6 34.9 29.4 34.9 35.8 36.2" fill="none" stroke="${stroke}" stroke-width="1" opacity="0.4"/>`
        // forro interno da caçamba (laterais da carroceria ficam amarelas)
        + `<rect x="13.6" y="37.8" width="20.8" height="17.6" rx="1.4" fill="${bed}"/>`
        + `<path d="M17.2 39 L17.2 54.2 M24 39 L24 54.2 M30.8 39 L30.8 54.2" stroke="${preta ? '#08090b' : '#0e0e10'}" stroke-width="1" opacity="0.7"/>`
        // lanternas
        + `<path d="M11.6 55.4 C12.9 56.5 14.6 57.1 16 57.3 L15.6 59.6 C14 59.3 12.4 58.6 11.2 57.5 Z" fill="${tail}"/>`
        + `<path d="M36.4 55.4 C35.1 56.5 33.4 57.1 32 57.3 L32.4 59.6 C34 59.3 35.6 58.6 36.8 57.5 Z" fill="${tail}"/>`;
}

function htmlSvgCarro(variant, w, h) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 64" width="${w}" height="${h}" style="display:block;pointer-events:none;background:transparent">${carSvgPaths(variant)}</svg>`;
}

function montarNoCarro(variant, w, h) {
    const rot = document.createElement('div');
    rot.className = 'vap-car-rot';
    rot.style.cssText = `width:${w}px;height:${h}px;transform-origin:50% 50%;transform:rotate(0deg) translateZ(0);`
        + 'background:transparent;backface-visibility:hidden;-webkit-backface-visibility:hidden;contain:layout style paint;';
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
    const f = Math.pow(1.12, z - 15);   // zoom 15 = 30×40 px (padrão do app)
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

// Overlay HTML no mapa (não precisa de mapId — libera ESTILO_MAPA_CLARO local).
// Classe cacheada: recriar `class extends OverlayView` a cada marcador quebra
// o ciclo de vida do Maps em alguns browsers e o carrinho/pulso some.
let _VapHtmlMarkerClass = null;
function obterVapHtmlMarkerClass() {
    if (_VapHtmlMarkerClass) return _VapHtmlMarkerClass;
    const Overlay = google.maps.OverlayView;
    _VapHtmlMarkerClass = class VapHtmlMarker extends Overlay {
        constructor(position, content, zIndex, title) {
            super();
            this.pos = normalizarLatLng(position);
            this._content = content || null;
            this.div = null;
            this._z = zIndex;
            this._title = title || '';
            this._listeners = [];
        }
        onAdd() {
            if (this.div) return;
            const panes = this.getPanes();
            // getPanes() pode ser null se o mapa ainda não montou — sem isso o
            // append lança e o marcador some para sempre.
            if (!panes) return;
            const pane = panes.overlayMouseTarget || panes.floatPane || panes.overlayLayer;
            if (!pane) return;
            const div = document.createElement('div');
            div.className = 'vap-html-marker';
            div.style.cssText = 'position:absolute;transform:translate(-50%,-50%);cursor:pointer;'
                + 'background:transparent;border:0;padding:0;line-height:0;user-select:none;'
                + 'pointer-events:auto;will-change:left,top;';
            if (this._z != null) div.style.zIndex = String(this._z);
            if (this._title) div.title = this._title;
            if (this._content) div.appendChild(this._content);
            this.div = div;
            pane.appendChild(div);
            this._listeners.forEach(({ ev, fn }) => div.addEventListener(ev, fn));
        }
        draw() {
            // Se onAdd falhou (panes null), tenta de novo no draw.
            if (!this.div) {
                try { this.onAdd(); } catch (_) { return; }
            }
            if (!this.div || !this.pos) return;
            const proj = this.getProjection();
            if (!proj) return;
            const pt = proj.fromLatLngToDivPixel(new google.maps.LatLng(this.pos.lat, this.pos.lng));
            if (!pt) return;
            this.div.style.left = pt.x + 'px';
            this.div.style.top = pt.y + 'px';
        }
        onRemove() {
            if (this.div?.parentNode) this.div.parentNode.removeChild(this.div);
            this.div = null;
        }
        setPosition(p) {
            this.pos = normalizarLatLng(p);
            this.draw();
        }
        getPosition() {
            if (!this.pos) return null;
            return { lat: () => this.pos.lat, lng: () => this.pos.lng };
        }
        setTitle(t) {
            this._title = t || '';
            if (this.div) this.div.title = this._title;
        }
        addDomListener(ev, fn) {
            this._listeners.push({ ev, fn });
            if (this.div) this.div.addEventListener(ev, fn);
            return { remove: () => this.div && this.div.removeEventListener(ev, fn) };
        }
    };
    return _VapHtmlMarkerClass;
}

function criarOverlayHtml(map, position, content, zIndex, title) {
    const Cls = obterVapHtmlMarkerClass();
    const ov = new Cls(position, content, zIndex, title);
    ov.setMap(map || null);
    return ov;
}

// Marcador moderno: AdvancedMarkerElement (com Map ID real) ou OverlayView (DEMO + estilo local).
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
            wrap.style.cssText = `position:relative;width:${iw}px;height:${ih}px;overflow:visible;background:transparent;`;
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
            const wrap = document.createElement('div');
            wrap.style.cssText = `position:relative;width:${iw}px;height:${ih}px;background:transparent;`;
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
        // Pin HTML (evita pin.element deprecado e é mais rápido no DEMO/OverlayView)
        const d = document.createElement('div');
        d.style.cssText = 'width:18px;height:18px;border-radius:50%;background:'
            + (cor || '#EA4335') + ';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);';
        if (label) {
            d.style.cssText = 'min-width:22px;height:22px;padding:0 5px;border-radius:11px;background:'
                + (cor || '#EA4335') + ';border:2px solid #fff;color:#fff;font:700 11px/18px system-ui,sans-serif;'
                + 'text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);';
            d.textContent = label;
        }
        content = d;
        // Com Map ID real ainda pode usar PinElement nativo (sem .element)
        if (_PinElement && mapaIdEfetivo()) {
            try {
                const pinOpts = {
                    background: cor || '#EA4335',
                    borderColor: '#fff',
                    glyphColor: '#fff',
                    scale: label ? 1.1 : 0.85,
                };
                if (label) pinOpts.glyphText = label;
                pinEl = new _PinElement(pinOpts);
                content = pinEl;
            } catch (_) { /* mantém HTML */ }
        }
    }

    // Advanced Marker só com Map ID real; DEMO (mapa branco) → OverlayView HTML.
    const zEfetivo = zIndex != null ? zIndex : (iconVariant ? 100 : (content ? 50 : undefined));
    const usarAdvanced = !!(mapaIdEfetivo() && _AdvancedMarkerElement);
    let mk = null;
    let ov = null;
    if (usarAdvanced) {
        mk = new _AdvancedMarkerElement({
            map: map || null,
            position: normalizarLatLng(position),
            title: title || '',
            content: content || null,
            zIndex: zEfetivo,
        });
    } else {
        ov = criarOverlayHtml(map, position, content, zEfetivo, title);
    }

    let _headingDeg = heading != null ? Number(heading) || 0 : 0;
    const aplicarRotacao = () => {
        if (!rotEl || rotEl.dataset.semGiro) return;
        rotEl.style.transform = `rotate(${_headingDeg}deg) translateZ(0)`;
    };
    if (_headingDeg) aplicarRotacao();

    const api = {
        setPosition(p) {
            const pos = normalizarLatLng(p);
            if (mk) mk.position = pos;
            else if (ov) ov.setPosition(pos);
        },
        getPosition() {
            if (mk) return posicaoLegada(mk);
            if (ov) return ov.getPosition();
            return null;
        },
        setMap(m) {
            if (!m && mapRef && iconVariant) removerMarcadorCarro(mapRef, api);
            if (mk) mk.map = m;
            else if (ov) ov.setMap(m || null);
            if (m) {
                mapRef = m;
                if (iconVariant) registrarMarcadorCarro(m, api);
            }
        },
        setTitle(t) {
            if (mk) mk.title = t || '';
            else if (ov) ov.setTitle(t || '');
        },
        getHeading() { return _headingDeg; },
        setHeading(h) {
            if (!rotEl && !imgEl) return;
            _headingDeg = Number(h) || 0;
            if (rotEl) { aplicarRotacao(); return; }
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
            if (mk) {
                const e = ev === 'click' ? 'gmp-click' : ev;
                if (e === 'gmp-click') mk.gmpClickable = true;
                if (typeof mk.addEventListener === 'function') {
                    mk.addEventListener(e, fn);
                    return { remove: () => mk.removeEventListener(e, fn) };
                }
                return mk.addListener(e, fn);
            }
            const domEv = ev === 'gmp-click' ? 'click' : ev;
            return ov.addDomListener(domEv, fn);
        },
    };
    if (mapRef && iconVariant) registrarMarcadorCarro(mapRef, api);
    return api;
}

// Rotas: SOMENTE via /api/rotas (cache no servidor). Não chama Routes no browser
// (cada computeRoutes do client = cobrança extra + falha comum).
function criarRotaControle(map, polylineOptions = {}) {
    const estilo = {
        strokeColor: '#000000',
        strokeWeight: 6,
        strokeOpacity: 0.95,
        geodesic: true,
        zIndex: 40,
        clickable: false,
        ...polylineOptions,
    };
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
                const resp = await calcularRotaServidor(o, d);
                // path e fallbackLine vêm iguais do servidor; desenha sempre que houver.
                const pts = (resp._path && resp._path.length >= 2)
                    ? resp._path
                    : (resp._fallbackLine || null);
                if (pts?.length >= 2 && map) desenharLinha(pts);
                return resp;
            } catch (err) {
                // Sem Google: linha reta local (não gera cota).
                const resp = respostaRotaFallback(o, d);
                if (map && resp._fallbackLine) desenharLinha(resp._fallbackLine);
                return resp;
            }
        },
        limpar() {
            polylines.forEach((pl) => pl.setMap(null));
            polylines = [];
        },
        /** true se há polyline viva no mapa (evita “path em memória, linha sumiu”). */
        temLinha() {
            return polylines.some((pl) => {
                try { return pl.getMap() != null; } catch (_) { return false; }
            });
        },
        // Traça uma polyline já conhecida (ex.: rota do simulador vinda do
        // servidor) — nenhuma chamada à Routes API.
        desenhar(pontos) {
            ctrl.limpar();
            const pts = (pontos || []).map(normalizarLatLng).filter(Boolean);
            if (pts.length >= 2) desenharLinha(pts);
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
            } else {
                const pts = (resp?._path && resp._path.length >= 2)
                    ? resp._path
                    : resp?._fallbackLine;
                if (pts?.length >= 2) desenharLinha(pts);
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
                    <video class="cam-video" autoplay playsinline muted></video>
                    <p class="cam-hint">${hintTexto} • foto real (sem zoom/espelho) · só câmera ao vivo</p>
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
            // Proporção 4:3 (nativa do sensor): pedir 16:9 força crop digital e o
            // rosto aparece "estourado" (efeito de zoom). 4:3 usa o sensor inteiro.
            const tentativas = facing === 'user'
                ? [
                    { video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 960 }, aspectRatio: { ideal: 4 / 3 } }, audio: false },
                    { video: { facingMode: 'user' }, audio: false },
                    { video: true, audio: false },
                ]
                : [
                    { video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 }, aspectRatio: { ideal: 4 / 3 } }, audio: false },
                    { video: { facingMode: facing }, audio: false },
                    { video: true, audio: false },
                ];
            for (const opts of tentativas) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia(opts);
                    // Alguns Androids abrem a câmera com zoom digital > 1 (rosto
                    // enorme). Volta ao zoom mínimo sempre que o aparelho permitir.
                    try {
                        const track = stream.getVideoTracks()[0];
                        const caps = track && track.getCapabilities ? track.getCapabilities() : null;
                        if (caps && caps.zoom && Number.isFinite(caps.zoom.min)) {
                            await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] });
                        }
                    } catch (_) { /* zoom não ajustável neste aparelho */ }
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