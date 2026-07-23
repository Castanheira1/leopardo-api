# Textos prontos — Google Play e App Store

Copie e cole nas fichas das lojas. Ajuste se o nome do projeto na empresa for diferente.

---

## Nome do app

**VAP — Conectando pessoas**

(Nome curto na home do celular: **VAP**)

---

## Descrição curta (Google Play, até 80 caracteres)

App interno de caronas entre colaboradores do mesmo projeto.

---

## Descrição completa

O VAP conecta motoristas e passageiros do mesmo projeto para compartilhar caronas de forma segura e organizada.

**Para passageiros**
- Veja caronas e motoristas disponíveis no mapa
- Solicite vaga ou envie contato quando o destino é parecido
- Acompanhe a viagem em tempo real

**Para motoristas**
- Publique sua rota e vagas disponíveis
- Receba pedidos de carona na sua região
- Gerencie propostas e passageiros

**Segurança**
- Cadastro com matrícula e validação
- Selfie e foto do veículo para identificação
- Política de privacidade e exclusão de conta no próprio app

O VAP é destinado a colaboradores autorizados do projeto. É necessário login com matrícula.

---

## Categoria

- Google Play: **Mapas e navegação** ou **Viagens e guias locais**
- App Store: **Travel** ou **Navigation**

---

## URLs obrigatórias

| Campo | URL |
|-------|-----|
| Política de privacidade | https://leopardo-api.onrender.com/politica-privacidade.html |
| Termos de uso | https://leopardo-api.onrender.com/termos-de-uso.html |
| Exclusão de conta | https://leopardo-api.onrender.com/excluir-conta.html |

---

## E-mail de suporte

Preencha com o e-mail do DPO ou suporte do projeto (o mesmo da política de privacidade).

---

## Capturas de tela (tire do app real)

Mínimo sugerido (5 telas):

1. Login / escolha de papel (motorista ou passageiro)
2. Mapa com caronas ou motoristas
3. Solicitar carona / buscar destino
4. Viagem em andamento ou histórico
5. Perfil (mostrando opção **Excluir conta**)

**Tamanhos iOS (obrigatórios):** iPhone 6,7" (1290×2796) e 6,5" (1284×2778) — use simulador Xcode ou device real.

**Android:** mínimo 2 capturas de telefone (1080×1920 ou superior).

---

## Notas para revisão da Apple (App Review Information)

```
App interno de caronas para colaboradores autorizados (login com matrícula).

Recursos nativos além do WebView:
- GPS em primeiro e segundo plano durante viagem ativa (foreground service no Android)
- Câmera para selfie de segurança
- Push notifications para ofertas de carona

Conta de teste para revisão:
Matrícula: [PREENCHER]
Senha: [PREENCHER]

Localização em background: usada apenas durante viagem em andamento, com notificação visível ao motorista.
```

---

## Declaração — localização em segundo plano (Google Play)

**Por que o app precisa de localização em background?**

Para rastrear a viagem em andamento quando o motorista ou passageiro minimiza o app, garantindo segurança e acompanhamento da carona em tempo real. Uma notificação persistente informa que o rastreamento está ativo.

Anexe um vídeo curto (30–60 s) mostrando: iniciar viagem → minimizar app → notificação “Rastreando sua viagem” visível.
