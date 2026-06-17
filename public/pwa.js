// Registra o Service Worker e recarrega o app automaticamente quando uma nova
// versão é publicada (após deploy no Render), para o usuário não ficar preso a
// uma versão antiga em cache.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Se a página já estava sendo controlada por um SW, qualquer troca de
    // controller é uma ATUALIZAÇÃO (não a primeira instalação) → recarrega.
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
        // Verifica se há versão nova sempre que o app volta ao primeiro plano.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update();
        });
      })
      .catch(() => {});
  });
}
