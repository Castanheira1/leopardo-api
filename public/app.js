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
                canvas.width = video.videoWidth || 720;
                canvas.height = video.videoHeight || 960;
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
async function lerPlaca(canvas) {
    try {
        await carregarScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        const { data } = await Tesseract.recognize(dataUrl, 'eng', {
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        });
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
