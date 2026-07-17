// Constantes de ambiente e raios/limites do produto (era o topo do server.js).
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "veiculos";
// Raio (km) de proximidade para considerar origem/destino "perto" (match)
const RAIO_KM = Number(process.env.RAIO_MATCH_KM || 3);
// Raio (km) de VISIBILIDADE no mapa e nos avisos: carona é coisa de gente
// próxima — mais que isso pega outra cidade e vira bagunça.
const RAIO_VISIVEL_KM = Number(process.env.RAIO_VISIVEL_KM || 10);
// Raio (km) do aviso com o APP FECHADO: motorista habilitado que está BEM
// perto (última posição do dia) é avisado por push mesmo sem app aberto e
// sem carona publicada — "estou na sala e alguém pediu aqui do lado".
const RAIO_PUSH_PERTO_KM = Number(process.env.RAIO_PUSH_PERTO_KM || 1);
// Raio (km) do modo motorista online: pedidos no mapa, visibilidade e push (600 m).
const RAIO_ONLINE_KM = Number(process.env.RAIO_ONLINE_KM || 0.6);
// Raio (km) da faixa ao redor da ROTA (linha reta origem->destino) escolhida
// pelo passageiro: motorista "na pista" entra na fila se estiver a até esta
// distância do trajeto (não só perto da origem).
const RAIO_ROTA_KM = Number(process.env.RAIO_ROTA_KM || 1.5);
// Mesmo ponto de destino (não confundir com RAIO_VISIVEL_KM de 10 km).
const RAIO_MESMO_DEST_KM = Number(process.env.RAIO_MESMO_DEST_KM || 1.5);
// Campus / POIs próximos (ex.: Portaria ↔ Central ~3,2 km no S11D).
const RAIO_PROXIMO_KM = Number(process.env.RAIO_PROXIMO_KM || 4);
// Fila de chamada sequencial (mais perto primeiro): quanto tempo cada
// motorista tem pra responder antes de passar pro próximo da fila.
// 60 s por motorista: com o pedido "para agora" vivendo 10 min, dá tempo de
// chamar ~9 candidatos (com 120 s só ~5 eram chamados e o resto nunca via a oferta).
const FILA_OFERTA_TIMEOUT_S = Number(process.env.FILA_OFERTA_TIMEOUT_S || 60);
// Dois limites de GPS, para não punir sinal instável (túnel, iOS em background):
//  - FRESH: some do MAPA na hora (mata fantasma visualmente), mas a publicação
//    continua no banco — o motorista reaparece quando o GPS volta.
//  - STALE: só aqui a publicação é REALMENTE cancelada (sumiu de vez).
const GPS_FRESH_MIN = Number(process.env.GPS_FRESH_MIN || 3);
const GPS_STALE_MIN = Number(process.env.GPS_STALE_MIN || 15);
const SQL_GPS_FRESH = `atualizado_em > NOW() - INTERVAL '${GPS_FRESH_MIN} minutes'`;
const SQL_GPS_STALE = `atualizado_em <= NOW() - INTERVAL '${GPS_STALE_MIN} minutes'`;
// Mapa do passageiro: rota publicada exige GPS fresco; modo amarelo tolera até STALE
// (senão some com sinal instável entre 3–15 min, mas sem ressuscitar fantasma).
const sqlGpsVisivelMapa = (alias = "l") => `(
  (${alias}.online_desde IS NULL AND ${SQL_GPS_FRESH.replace("atualizado_em", alias + ".atualizado_em")})
  OR (${alias}.online_desde IS NOT NULL AND NOT (${SQL_GPS_STALE.replace("atualizado_em", alias + ".atualizado_em")}))
)`;

// Intervalo do "avançador" da fila (verifica ofertas vencidas).
const FILA_TICK_MS = Number(process.env.FILA_TICK_MS || 10 * 1000);
// Viagem só conta no rateio/admin se o GPS registrar deslocamento real (não simulação parado).
const KM_MINIMO_VIAGEM = Number(process.env.KM_MINIMO_VIAGEM || 0.5);
const KM_SEGMENTO_MIN = Number(process.env.KM_SEGMENTO_MIN || 0.03);
const KM_VELOCIDADE_MAX_H = Number(process.env.KM_VELOCIDADE_MAX_H || 120);
const RAIO_CHEGADA_DEST_KM = Number(process.env.RAIO_CHEGADA_DEST_KM || 0.15);
// Fuso dos projetos (canteiros Vale/PA). Horário agendado é horário de parede local.
const FUSO_APP = process.env.APP_TIMEZONE || "America/Sao_Paulo";

if (!JWT_SECRET) {
  console.error("ERRO: JWT_SECRET não definido no .env");
  process.exit(1);
}


const HAB_SELFIE_HORAS = 12;


module.exports = {
  PORT,
  JWT_SECRET,
  SUPABASE_BUCKET,
  RAIO_KM,
  RAIO_VISIVEL_KM,
  RAIO_PUSH_PERTO_KM,
  RAIO_ONLINE_KM,
  RAIO_ROTA_KM,
  RAIO_MESMO_DEST_KM,
  RAIO_PROXIMO_KM,
  FILA_OFERTA_TIMEOUT_S,
  GPS_FRESH_MIN,
  GPS_STALE_MIN,
  SQL_GPS_FRESH,
  SQL_GPS_STALE,
  sqlGpsVisivelMapa,
  FILA_TICK_MS,
  KM_MINIMO_VIAGEM,
  KM_SEGMENTO_MIN,
  KM_VELOCIDADE_MAX_H,
  RAIO_CHEGADA_DEST_KM,
  FUSO_APP,
  HAB_SELFIE_HORAS,
};
