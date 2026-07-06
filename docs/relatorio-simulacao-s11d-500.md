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

## Resultado: sucesso funcional — e os 2 achados de código já foram corrigidos

A primeira rodada (commit `c58a0f5`, PR #172) fechou 100% do funil sem erro 500,
sem timeout de banco e sem corrupção de dado, mas expôs **3 dificuldades reais**.
Duas eram bugs de código e foram corrigidas nesta mesma branch; a terceira é uma
característica do limitador de requisições (não um bug) e foi deixada como está,
a pedido — a operação real do S11D usa 4G/5G individual por colaborador, não uma
rede corporativa compartilhada, então o risco descrito não se aplica aqui.

Depois da correção, a simulação foi rodada de novo do zero: **2.666 requisições,
0 falhas** (antes: 40 falhas, todas do achado nº 2).

### 1. `/api/motoristas-online` podia esconder um motorista a 5 metros de distância — CORRIGIDO

O endpoint que alimenta o mapa (`GET /api/motoristas-online`, server.js:2103) mistura
dois raios de visibilidade — **600 m** para quem está no "modo amarelo" (sem destino)
e **10 km** para quem tem uma carona ativa publicada — numa única consulta com
`LIMIT 100`. Antes, o resultado era ordenado por `u.id` (ordem de cadastro): com 125
motoristas de carona publicada (raio de 10 km, cobre quase todo o S11D) e 125 em
modo amarelo coexistindo, os primeiros preenchiam as 100 posições do limite antes
de o motorista amarelo — mesmo a poucos metros do passageiro — aparecer na lista.
Na simulação original isso derrubou a visibilidade do modo amarelo de 100% (testado
isolado) para **65/125 (52%)**.

**Correção:** a consulta agora primeiro reduz a 1 linha por motorista (CTE) e só
depois aplica o filtro de raio e ordena **pela distância real** até quem está
consultando — não mais pelo `id` de cadastro — antes do `LIMIT 100`. Assim, as 100
posições são sempre as 100 mais PRÓXIMAS, não as 100 de cadastro mais antigo.

**Depois da correção:** 125/125 motoristas amarelo vistos pelo passageiro certo
(era 65/125). Reprodução isolada do caso de 0,8 m de distância confirmada como
resolvida.

*(A listagem geral sem `lat`/`lng` — usada por telas que não têm uma posição de
referência — continua limitada a 100 registros; sem um ponto de referência não há
"mais perto" para ordenar. Isso não estava no achado original, que era
especificamente sobre a visão do passageiro a partir da própria posição.)*

### 2. Vagas de uma carona não eram decrementadas — CORRIGIDO

Em `criarViagemDaProposta` (server.js, antes na linha 1860), assim que **qualquer**
proposta era aceita, a carona inteira virava `status = 'concluida'`, ignorando o
campo `vagas` — um motorista com 3 assentos livres perdia a carona para os outros
2 lugares assim que aceitava o primeiro passageiro. Testado com 40 caronas com
`vagas > 1`: em 100% dos casos (40/40), o segundo passageiro recebia
`404 "Carona indisponível"` mesmo com 2 lugares livres.

**Correção:** cada aceite agora decrementa `vagas` em 1
(`vagas = GREATEST(vagas - 1, 0)`), e a carona só vira `concluida` quando as vagas
chegam a 0 — continua `ativa` (visível no mapa e em `/api/caronas/match`) enquanto
houver assento livre. Ao cancelar uma proposta que já tinha sido aceita, a vaga
volta (`vagas = vagas + 1`) e a carona reabre; se a proposta cancelada ainda estava
só pendente, nenhuma vaga é devolvida (nunca tinha sido ocupada).

**Depois da correção:** as mesmas 40 caronas com `vagas > 1` — agora **40/40 ainda
aceitam uma segunda proposta** depois do primeiro aceite, exatamente o esperado.

### 3. Limitador de requisições global (1200/15 min) é por IP — não corrigido (fora de escopo)

`server.js:51` aplica um limite global de 1200 requisições/15 min por IP a toda a
API (confirmado: o 429 aparece exatamente na requisição nº 1200 de um mesmo IP; o
fluxo de 500 usuários gera 2.666 requisições reais). Isso não é um bug — é proteção
antiabuso funcionando como projetado. O risco descrito na primeira rodada (uso
simultâneo por muitos dispositivos atrás do mesmo gateway/NAT corporativo) **não
se aplica ao S11D**, já que cada colaborador acessa por 4G/5G individual — por
isso este ponto foi deixado como está, sem alteração de código.

*(O `RATE_LIMIT_MAX` — variável de ambiente opcional adicionada ao limitador
global, mesmo padrão do `AUTH_RATE_MAX` já existente, com valor-padrão de 1200
inalterado — continua no código só para permitir rodar este teste de carga a
partir de um único IP de loopback; não muda nada em produção.)*

## Números completos (depois das correções)

| Etapa | Resultado |
|---|---:|
| Usuários cadastrados | 500/500 |
| Motoristas habilitados (placa + selfie + foto do carro) | 250/250 |
| Caronas publicadas (com destino) | 125/125 |
| Motoristas em modo amarelo (online, sem destino) | 125/125 |
| Pedidos de carona publicados | 250/250 |
| Caronas com destino vistas no mapa pelo passageiro certo | 125/125 |
| Motoristas amarelo vistos no mapa pelo passageiro certo (600 m) | **125/125** (era 65/125) |
| Listagem geral do mapa (sem filtro de raio, sem ponto de referência) | 100 de 250 (`LIMIT 100`, não é o achado nº 1 — ver nota acima) |
| Propostas de vaga em carona publicada | 125/125 |
| Propostas de motorista amarelo → pedido | 125/125 |
| Viagens iniciadas | 250/250 |
| Viagens finalizadas com rota GPS e distância calculada | 250/250 |
| Vagas testadas após 1º aceite (caronas com vagas > 1) | **40/40 ainda disponíveis** (era 0/40) |
| Requisições HTTP totais / falhas | **2.666 / 0** (era 2.666 / 40) |
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
