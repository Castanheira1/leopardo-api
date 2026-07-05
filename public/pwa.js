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
    el.className = "vap-offline-bar";
    el.textContent = "Sem conexão — mostrando a última versão carregada";
    document.body.appendChild(el);
    const sync = () => {
      el.classList.toggle("visivel", !navigator.onLine);
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
