/* ============================================================
   Vagão - utilidades globais (auth, mapa, câmera, OCR)
   ============================================================ */

function checkAuth(adminOnly = false) {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    if (!token || !user) { location.href = 'index.html'; return; }
    if (adminOnly && !user.is_admin) { avisoProximaPagina('Acesso restrito a administradores.'); location.href = 'dashboard.html'; return; }
    const el = document.getElementById('userName');
    if (el) el.textContent = `Olá, ${user.nome.split(' ')[0]}!`;
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
        overlay.className = 'cam-overlay';
        overlay.innerHTML = `
            <div class="cam-box">
                <h3>${titulo}</h3>
                <video class="cam-video" autoplay playsinline muted></video>
                <p class="cam-hint">${hintTexto} • foto ao vivo (não é possível anexar)</p>
                <div class="cam-actions">
                    <button type="button" class="btn btn-secondary cam-cancel">Cancelar</button>
                    <button type="button" class="btn btn-primary cam-shot"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Capturar</button>
                </div>
                <div class="cam-status"></div>
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

            const em = new Date().toISOString();
            status.textContent = ocrPlaca ? 'Enviando e lendo placa...' : 'Enviando foto...';

            const locPromise = obterLocalizacaoRapida();
            const blobPromise = new Promise((r) => canvas.toBlob(r, 'image/jpeg', qualidade));
            const ocrPromise = ocrPlaca ? lerPlaca(canvas) : Promise.resolve(null);

            const uploadPromise = blobPromise.then(async (blob) => {
                const fd = new FormData();
                fd.append('foto', blob, `${tipo}.jpg`);
                fd.append('tipo', tipo);
                const resp = await fetchWithAuth('/api/fotos', { method: 'POST', body: fd });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'Falha no upload');
                return data.url;
            });

            const [url, placa, loc] = await Promise.all([uploadPromise, ocrPromise, locPromise]);

            encerrar();
            resolve({ url, lat: loc.lat, lng: loc.lng, em, placa });
        }

        // Fallback iPhone/PWA: quando a câmera web (getUserMedia) não existe ou não
        // abre — comum no iOS em app instalado ou permissão negada — usa a câmera
        // NATIVA via input capture. Continua sendo foto tirada na hora: o capture
        // abre direto a câmera do aparelho, não a galeria.
        function usarCameraNativa(motivo) {
            if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
            video.style.display = 'none';
            status.textContent = motivo || '';
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            // setAttribute (não a propriedade): é o ATRIBUTO html que o iOS lê
            // para abrir a câmera direto em vez da galeria.
            input.setAttribute('capture', facing === 'user' ? 'user' : 'environment');
            input.style.display = 'none';
            overlay.appendChild(input);
            btnShot.textContent = 'Abrir câmera';
            btnShot.onclick = () => input.click();
            input.onchange = async () => {
                const file = input.files && input.files[0];
                if (!file) return;
                const url = URL.createObjectURL(file);
                try {
                    status.textContent = 'Processando...';
                    const img = new Image();
                    await new Promise((ok, err) => {
                        img.onload = ok;
                        img.onerror = () => err(new Error('Não deu para ler a foto. Tente de novo.'));
                        img.src = url;
                    });
                    await processarEnviar(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
                } catch (e) {
                    status.textContent = 'Erro: ' + e.message;
                } finally { URL.revokeObjectURL(url); }
            };
        }

        btnShot.onclick = async () => {
            try {
                status.textContent = 'Processando...';
                // iOS às vezes demora a soltar as dimensões do vídeo — esperar o
                // metadata evita capturar uma selfie preta de 0x0.
                if (!video.videoWidth) {
                    await new Promise((ok) => {
                        video.addEventListener('loadedmetadata', ok, { once: true });
                        setTimeout(ok, 2000);
                    });
                }
                await processarEnviar(video, video.videoWidth || 720, video.videoHeight || 960);
            } catch (e) {
                status.textContent = 'Erro: ' + e.message;
            }
        };

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({
                video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 960 } },
                audio: false,
            })
                .then((s) => {
                    stream = s;
                    video.srcObject = s;
                    // iOS nem sempre respeita o autoplay mesmo com playsinline+muted.
                    const p = video.play(); if (p && p.catch) p.catch(() => {});
                })
                .catch(() => usarCameraNativa('A câmera do navegador não abriu — toque em "Abrir câmera" para usar a câmera do aparelho.'));
        } else {
            usarCameraNativa('Toque em "Abrir câmera" para tirar a foto com a câmera do aparelho.');
        }
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
