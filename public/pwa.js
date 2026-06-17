// Registra o Service Worker, recarrega o app quando uma nova versão é publicada
// (após deploy no Render) e mostra um aviso leve quando o usuário fica sem
// internet — sem quebrar a tela.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Se a página já era controlada por um SW, qualquer troca de controller é uma
    // ATUALIZAÇÃO (não a primeira instalação) → recarrega para pegar a versão nova.
    const jaControlado = Boolean(navigator.serviceWorker.controller);
    let recarregando = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (recarregando || !jaControlado) return;
      recarregando = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("/service-worker.js")
      .then((reg) => {
        // Procura atualização sempre que o app volta ao primeiro plano.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update();
        });
      })
      .catch(() => {});
  });
}

// Aviso discreto de "sem conexão" — o app continua mostrando a última versão.
(function indicadorOffline() {
  function montar() {
    if (document.getElementById("vagao-offline")) return;
    const el = document.createElement("div");
    el.id = "vagao-offline";
    el.textContent = "Sem conexão — mostrando a última versão carregada";
    el.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#0F3D3E;" +
      "color:#EAD298;font:600 13px/1.4 system-ui,sans-serif;text-align:center;" +
      "padding:8px 12px;transform:translateY(110%);transition:transform .25s ease;" +
      "box-shadow:0 -2px 8px rgba(0,0,0,.25)";
    document.body.appendChild(el);
    const sync = () => {
      el.style.transform = navigator.onLine ? "translateY(110%)" : "translateY(0)";
    };
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    sync();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", montar);
  } else {
    montar();
  }
})();
