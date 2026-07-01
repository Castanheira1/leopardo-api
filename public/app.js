/* ============================================================
   Vagão - utilidades globais (auth, mapa, câmera, OCR)
   ============================================================ */

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

    const resp = await fetch(url, { ...options, headers, credentials: 'include' });
    if (resp.status === 401) { alert('Sessão expirada'); logout(); }
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

/* -------------------- Google Maps -------------------- */
let _mapsPromise = null;
function carregarMaps() {
    if (_mapsPromise) return _mapsPromise;
    _mapsPromise = (async () => {
        const cfg = await (await fetch('/api/config')).json();
        if (!cfg.mapsApiKey) throw new Error('Google Maps API key não configurada (.env GOOGLE_MAPS_API_KEY)');
        await carregarScript(`https://maps.googleapis.com/maps/api/js?key=${cfg.mapsApiKey}&libraries=places`);
        return window.google;
    })();
    return _mapsPromise;
}

/* -------------------- Geolocalização -------------------- */
function obterLocalizacao(opts = {}) {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Geolocalização indisponível'));
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 0, ...opts }
        );
    });
}

/* -------------------- Câmera (captura AO VIVO, sem anexar arquivo) -------------------- */
/*
   capturarFoto({ tipo: 'selfies'|'carros', facing: 'user'|'environment', ocrPlaca: bool, titulo })
   -> resolve { url, lat, lng, em, placa? }  (placa só quando ocrPlaca = true)
*/
function capturarFoto(opts = {}) {
    const { tipo = 'outros', facing = 'environment', ocrPlaca = false, titulo = 'Tirar foto' } = opts;

    return new Promise((resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.className = 'cam-overlay';
        overlay.innerHTML = `
            <div class="cam-box">
                <h3>${titulo}</h3>
                <video class="cam-video" autoplay playsinline muted></video>
                <p class="cam-hint">${ocrPlaca ? 'Enquadre a placa dianteira do veículo' : 'Posicione o rosto e capture'} • foto ao vivo (não é possível anexar)</p>
                <div class="cam-actions">
                    <button type="button" class="btn btn-secondary cam-cancel">Cancelar</button>
                    <button type="button" class="btn btn-primary cam-shot"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Capturar</button>
                </div>
                <div class="cam-status"></div>
            </div>`;
        document.body.appendChild(overlay);

        const video = overlay.querySelector('.cam-video');
        const status = overlay.querySelector('.cam-status');
        let stream = null;

        const encerrar = () => {
            if (stream) stream.getTracks().forEach((t) => t.stop());
            overlay.remove();
        };

        navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false })
            .then((s) => { stream = s; video.srcObject = s; })
            .catch((e) => { encerrar(); reject(new Error('Não foi possível acessar a câmera: ' + e.message)); });

        overlay.querySelector('.cam-cancel').onclick = () => { encerrar(); reject(new Error('cancelado')); };

        overlay.querySelector('.cam-shot').onclick = async () => {
            try {
                status.textContent = 'Processando...';
                const canvas = document.createElement('canvas');
                // Teto de 1280px no lado maior: câmeras modernas geram fotos enormes
                // que só encarecem o upload — o enquadramento não muda.
                const vw = video.videoWidth || 720, vh = video.videoHeight || 960;
                const escala = Math.min(1, 1280 / Math.max(vw, vh));
                canvas.width = Math.round(vw * escala);
                canvas.height = Math.round(vh * escala);
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

                // Localização e horário do instante da captura
                let loc = { lat: null, lng: null };
                try { loc = await obterLocalizacao(); } catch (_) { /* segue sem GPS */ }
                const em = new Date().toISOString();

                // OCR da placa (Tesseract) antes de enviar
                let placa = null;
                if (ocrPlaca) {
                    status.textContent = 'Lendo a placa...';
                    placa = await lerPlaca(canvas);
                }

                status.textContent = 'Enviando foto...';
                const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
                const fd = new FormData();
                fd.append('foto', blob, `${tipo}.jpg`);
                fd.append('tipo', tipo);
                const resp = await fetchWithAuth('/api/fotos', { method: 'POST', body: fd });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'Falha no upload');

                encerrar();
                resolve({ url: data.url, lat: loc.lat, lng: loc.lng, em, placa });
            } catch (e) {
                status.textContent = 'Erro: ' + e.message;
            }
        };
    });
}

/* -------------------- OCR de placa (Tesseract.js) -------------------- */
// O Tesseract pesa vários MB (script + worker + wasm + traineddata). Pré-aquecer
// o worker no INÍCIO do fluxo (preCarregarOcr, fire-and-forget) faz o download
// acontecer enquanto o usuário tira as fotos, em vez de travar no "Lendo a placa...".
const _TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let _ocrWorkerPromise = null;
function preCarregarOcr() {
    if (!_ocrWorkerPromise) {
        _ocrWorkerPromise = (async () => {
            await carregarScript(_TESSERACT_SRC);
            const worker = await Tesseract.createWorker('eng');
            await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
            return worker;
        })();
        _ocrWorkerPromise.catch(() => { _ocrWorkerPromise = null; });   // permite nova tentativa
    }
    return _ocrWorkerPromise;
}
async function lerPlaca(canvas) {
    try {
        const worker = await preCarregarOcr();
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        const { data } = await worker.recognize(dataUrl);
        const texto = (data.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        // Mercosul: ABC1D23 | Antiga: ABC1234
        const m = texto.match(/[A-Z]{3}[0-9][A-Z0-9][0-9]{2}/);
        return m ? m[0] : null;
    } catch (e) {
        console.warn('OCR falhou:', e.message);
        return null;
    }
}

/* -------------------- Utilidades -------------------- */
function linkWhatsApp(telefone) {
    if (!telefone) return null;
    let n = String(telefone).replace(/\D/g, '');
    if (n.length <= 11) n = '55' + n; // assume Brasil
    return `https://wa.me/${n}`;
}

function fmtData(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR');
}

function fmtHorario(h) {
    return h ? new Date(h).toLocaleString('pt-BR') : 'Agora (tempo real)';
}
