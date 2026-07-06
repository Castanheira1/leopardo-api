# Simulação: 500 usuários / 500 caronas no S11D

## O que foi simulado

Script: `scripts/simulacao-s11d-500.js` (subido com `scripts/rodar-simulacao-s11d.sh`,
que cria um Postgres efêmero local, aplica `schema.sql` e sobe o próprio `server.js`
como processo real — nada mockado, todas as chamadas passam pela API HTTP de verdade).

**500 usuários distintos**, cadastrados no projeto **S11D**, com coordenadas
aleatórias dentro do polígono real do Complexo Serra Sul (extraído dos 49 locais de
`public/locais-favoritos.json`: lat -6.466 a -6.396, lng -50.372 a -50.202 — Canaã
dos Carajás/PA), divididos em:

| Papel | Qtd | Ação |
|---|---:|---|
| Motorista — **carona publicada** | 125 | habilita o carro e publica uma carona com origem/destino fixos (`POST /api/caronas`) |
| Motorista — **modo amarelo** (online, sem destino) | 125 | habilita o carro e liga o modo online (`POST /api/motorista/online`) |
| Passageiro (pareado com carona publicada) | 125 | publica um pedido de carona perto da rota do motorista |
| Passageiro (pareado com motorista amarelo) | 125 | publica um pedido de carona a até 500 m do motorista online |

Para cada um dos 250 pares motorista↔passageiro, a simulação percorreu o fluxo
completo: publicação → aparecer no mapa → proposta → aceite → gravação da rota GPS
→ finalização da viagem — **os dois fluxos de motorista pedidos no enunciado**
("motorista amarelo oferecendo carona" e "usuário publicou carona") foram exercidos
separadamente. Também testou vagas > 1 (decremento de assentos) e a visibilidade
"todos os carros no mapa".

## Resultado: sucesso funcional, com 3 dificuldades reais encontradas

**Sucesso** — as 500 cadastros, 250 habilitações, 125 caronas publicadas, 125
sessões "modo amarelo", 250 pedidos, 250 propostas, 250 aceites e **250 viagens
completas com rota GPS e cálculo de distância** fecharam 100% sem nenhum erro 500,
sem timeout de conexão com o banco e sem corrupção de dado — validado tanto pela
API quanto por contagem direta no Postgres. Latências ficaram baixas mesmo sob 25
requisições simultâneas (a maioria das rotas com p95 < 50 ms; cadastro, que faz
hash bcrypt, ficou em ~450 ms de p50 — esperado e aceitável).

As dificuldades abaixo são achados reais do código (`server.js`), não artefatos do
teste — cada um foi isolado e confirmado com uma reprodução mínima antes de entrar
neste relatório.

### 1. `/api/motoristas-online` pode esconder um motorista a 5 metros de distância

O endpoint que alimenta o mapa (`GET /api/motoristas-online`, server.js:2102) mistura,
numa única consulta, dois raios de visibilidade diferentes — **600 m** para quem está
no "modo amarelo" (sem destino) e **10 km** para quem tem uma carona ativa publicada
— e ordena o resultado por `u.id` (ordem de cadastro), não por distância, com
`LIMIT 100`.

Com 125 motoristas de carona publicada (raio de 10 km — cobre quase todo o S11D) e
125 motoristas em modo amarelo coexistindo, os primeiros preenchem as 100 posições
do limite antes de o motorista amarelo (cadastrado depois, `id` maior) entrar na
lista — mesmo quando ele está a **poucos metros** do passageiro. Na simulação, isso
derrubou a visibilidade do modo amarelo de 100% (quando testado isolado) para
**65/125 (52%)** quando os dois tipos de motorista coexistem em volume.

Reproduzido isoladamente (fora deste relatório): um passageiro a 0.8 m de um
motorista amarelo não o viu no mapa porque a resposta já vinha com exatamente 100
resultados — todos motoristas de carona publicada mais distantes, porém com `id`
menor.

**Risco em produção:** num site do tamanho do S11D, um passageiro pode simplesmente
não ver, no mapa, um motorista disponível ao lado dele — o app relata "sem
motorista por perto" quando na verdade há um a poucos metros.
**Sugestão:** ordenar por distância (não por `id`) e/ou paginar em vez de truncar
com `LIMIT 100` fixo; ou separar as duas consultas (amarelo vs. carona) em vez de
uni-las num só `LIMIT`.

### 2. Vagas de uma carona não são decrementadas — a 1ª proposta aceita fecha a carona inteira

Em `criarViagemDaProposta` (server.js:1860), assim que **qualquer** proposta é
aceita, a carona inteira vira `status = 'concluida'`:

```js
if (pr.carona_id) await pool.query("UPDATE caronas SET status = 'concluida' WHERE id = $1", [pr.carona_id]);
```

Isso ignora o campo `vagas`. Um motorista que publicou uma carona com 3 vagas e
aceitou o primeiro passageiro perde a carona para os outros 2 lugares — ela some do
mapa e de `/api/caronas/match` para todo mundo, mesmo com assentos livres.

Testado com 40 caronas com `vagas > 1` (2 ou 3 assentos) na simulação: em
**100% dos casos (40/40)**,
depois do primeiro aceite, um segundo passageiro que tentou pedir uma das vagas
restantes recebeu `404 "Carona indisponível"` — apesar de haver 2 lugares livres.

**Risco em produção:** motoristas com carro maior (SUV, van de obra) oferecendo
várias vagas efetivamente só conseguem preencher uma — o app subutiliza a
capacidade real da frota, o oposto do que o recurso `vagas` promete.
**Sugestão:** decrementar `vagas` a cada aceite e só marcar `concluida` quando
`vagas` chegar a 0 (ou quando o motorista encerrar manualmente).

### 3. Limitador de requisições global (1200/15 min) é por IP único — risco em rede corporativa compartilhada

`server.js:51` aplica um limite global de 1200 requisições/15 min por IP a **toda**
a API. Um teste de controle isolado (sem custo de banco, só `GET /api/config`)
confirmou que o 429 aparece exatamente na requisição nº 1200 de um mesmo IP.

A simulação completa (500 usuários fazendo o fluxo realista de cadastro → habilitação
→ publicar/pedir carona → match → proposta → aceite → rota → finalizar) gerou
**2.666 requisições HTTP** — mais que o dobro do teto padrão — vindas, neste teste,
de um único IP (o processo de simulação). Isso não é um problema do código em si (o
limite existe de propósito, contra força bruta), mas é um risco concreto e
específico do S11D: colaboradores de um site industrial normalmente saem para a
internet por um número pequeno de IPs de gateway/NAT corporativo — nesse caso, o
uso normal e simultâneo de algumas centenas de pessoas pelo mesmo gateway pode
disparar o 429 e bloquear todo mundo atrás daquele IP por 15 minutos, mesmo sem
nenhum ataque.
**Sugestão:** já existe o padrão certo no próprio arquivo (`AUTH_RATE_MAX` para
login/cadastro); o mesmo raciocínio vale para o limite global — considerar chavear
por usuário autenticado (JWT) além de IP, ou usar um teto mais alto/dinâmico para
o tráfego autenticado.

*(Nesta simulação, o limite global e o `AUTH_RATE_MAX` foram elevados via variáveis
de ambiente — `RATE_LIMIT_MAX`/`AUTH_RATE_MAX` — exatamente pelo motivo acima: 500
usuários reais viriam de 500 dispositivos/IPs diferentes, e não faria sentido medir
o resto do sistema apenas travado no limitador de um teste de carga single-machine.
O `RATE_LIMIT_MAX` foi adicionado ao `server.js` nesta mesma mudança, seguindo o
padrão já existente do `AUTH_RATE_MAX`, com o mesmo valor-padrão de 1200 — não
altera o comportamento em produção.)*

## Números completos

| Etapa | Resultado |
|---|---:|
| Usuários cadastrados | 500/500 |
| Motoristas habilitados (placa + selfie + foto do carro) | 250/250 |
| Caronas publicadas (com destino) | 125/125 |
| Motoristas em modo amarelo (online, sem destino) | 125/125 |
| Pedidos de carona publicados | 250/250 |
| Caronas com destino vistas no mapa pelo passageiro certo | 125/125 |
| Motoristas amarelo vistos no mapa pelo passageiro certo (600 m) | 65/125 *(achado nº 1)* |
| Listagem geral do mapa (sem filtro de raio) | 100 retornados de 250 ativos *(`LIMIT 100`, achado nº 1)* |
| Propostas de vaga em carona publicada | 125/125 |
| Propostas de motorista amarelo → pedido | 125/125 |
| Viagens iniciadas | 250/250 |
| Viagens finalizadas com rota GPS e distância calculada | 250/250 |
| Vagas testadas após 1º aceite (caronas com vagas > 1) | 40 testadas, 0 ainda disponíveis *(achado nº 2)* |
| Requisições HTTP totais / falhas | 2.666 / 40 (as 40 são exatamente o achado nº 2, esperado) |
| Duração total | ~11 s |

Relatório bruto (JSON com latências p50/p95 por rota e amostra de erros):
`docs/resultado-simulacao-s11d-500.json`.

## Como rodar de novo

```bash
bash scripts/rodar-simulacao-s11d.sh
```

Sobe um Postgres descartável em `/tmp`, aplica o schema, roda os 500 usuários e
imprime o resumo — não toca em nenhum banco de produção. Variáveis opcionais:
`SIM_CONCURRENCY` (padrão 25), `SIM_DRIVER_CARONA`/`SIM_DRIVER_AMARELO`/
`SIM_PAX_CARONA`/`SIM_PAX_AMARELO` (padrão 125 cada).
