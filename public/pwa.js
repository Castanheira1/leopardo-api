// Registra o Service Worker e recarrega o app quando uma nova versão é publicada
// (após deploy no Render). Avisos de conexão ficam no app.js (toast temporário).
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
