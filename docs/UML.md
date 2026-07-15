# VAP — Diagramas UML

Diagramas da arquitetura em [Mermaid](https://mermaid.js.org) (o GitHub renderiza
automaticamente). Fonte da verdade: `schema.sql` (dados), `server.js` (rotas) e
`docs/ARQUITETURA.md` (visão geral). Atualize este arquivo quando o fluxo principal
ou o schema mudarem.

## 1. Implantação (deployment)

```mermaid
flowchart LR
    subgraph Dispositivo["Dispositivo do usuário"]
        APP["App nativo (Capacitor)<br>Android/iOS — WebView"]
        PWA["Navegador (PWA)<br>manifest + service worker"]
    end

    subgraph Render["Render (Node 22)"]
        EX["server.js<br>Express + JWT + rate-limit"]
    end

    subgraph Supabase["Supabase"]
        PG[("PostgreSQL<br>via pg Pool")]
        ST[["Storage<br>bucket veiculos (fotos)"]]
    end

    GM["Google Maps JS + Places (CDN)"]
    TS["Tesseract.js — OCR de placa (CDN)"]
    WP["Web Push (VAPID)"]

    APP -->|"HTTPS /api/..."| EX
    PWA -->|"HTTPS /api/..."| EX
    EX -->|"DATABASE_URL (Session pooler)"| PG
    EX -->|"service_role key"| ST
    PWA -.->|carrega em runtime| GM
    PWA -.->|carrega em runtime| TS
    EX -->|notificações| WP
```

O app das lojas é um **shell Capacitor**: a WebView carrega
`https://leopardo-api.onrender.com` (ver `capacitor.config.ts`), então front e API
ficam no mesmo domínio e o código web roda sem alterações.

## 2. Entidades principais (ER)

```mermaid
erDiagram
    usuarios ||--o{ habilitacoes_motorista : "habilita-se por dia"
    usuarios ||--o{ caronas : "motorista oferece"
    usuarios ||--o{ pedidos : "passageiro solicita"
    usuarios ||--o| localizacoes_online : "posição ao vivo"
    usuarios }o--|| projetos : "pertence a"
    usuarios }o--|| empresas : "pertence a"
    caronas ||--o{ propostas : ""
    pedidos ||--o{ propostas : ""
    pedidos ||--o{ pedido_fila : "fila sequencial de motoristas"
    propostas ||--o| viagens : "aceita vira"
    viagens ||--o{ viagem_pontos : "rota GPS"
    projetos ||--o{ contratos : ""
    empresas ||--o{ contratos : "beneficiária/pagadora"

    usuarios {
        int id PK
        text matricula UK
        text senha_hash
        bool is_admin
        int projeto_id FK
        int empresa_id FK
    }
    habilitacoes_motorista {
        int id PK
        int motorista_id FK
        text selfie_url
        text foto_carro_url
        text placa
        date valida_em
    }
    caronas {
        int id PK
        int motorista_id FK
        numeric origem_lat_lng
        numeric destino_lat_lng
        text status "ativa|concluida|cancelada"
    }
    pedidos {
        int id PK
        int passageiro_id FK
        numeric origem_lat_lng
        numeric destino_lat_lng
        text status "aberto|atendido|cancelado"
    }
    propostas {
        int id PK
        int carona_id FK
        int pedido_id FK
        text status "pendente|aceito|recusado"
    }
    viagens {
        int id PK
        int proposta_id FK
        int motorista_id FK
        int passageiro_id FK
        text status "em_andamento|concluida|cancelada"
    }
    viagem_pontos {
        int id PK
        int viagem_id FK
        numeric lat_lng
        timestamp em
    }
```

Tabelas de apoio fora do diagrama: `matriculas_bloqueadas`, `tokens_recuperacao`,
`push_subscriptions`, `usuarios_favoritos`, `contatos_motorista`, `admin_chamados`.

## 3. Sequência — fluxo completo de uma carona

```mermaid
sequenceDiagram
    autonumber
    actor M as Motorista
    actor P as Passageiro
    participant API as server.js (Express)
    participant DB as PostgreSQL
    participant ST as Supabase Storage

    M->>API: POST /api/fotos (selfie + carro, câmera ao vivo)
    API->>ST: upload (service_role)
    ST-->>API: URLs públicas
    M->>API: POST /api/habilitacao (fotos + placa OCR)
    API->>DB: INSERT habilitacoes_motorista (válida hoje)
    M->>API: POST /api/caronas (origem, destino, horário)

    P->>API: POST /api/pedidos
    P->>API: GET /api/pedidos/match
    API->>DB: Haversine origem+destino ≤ RAIO_KM, janela ±1h
    DB-->>P: caronas compatíveis
    P->>API: POST /api/propostas
    API-->>M: push (proposta pendente)
    M->>API: POST /api/propostas/:id/aceitar
    Note over M,P: telefones liberados só após o aceite

    M->>API: POST /api/viagens (inicia)
    loop durante o trajeto
        M->>API: POST /api/viagens/:id/pontos (GPS)
        P->>API: GET /api/viagens/:id/localizacao
    end
    M->>API: POST /api/viagens/:id/finalizar
    API->>DB: status = concluida (rota + fotos ficam no histórico)
```

## 4. Estados

```mermaid
stateDiagram-v2
    direction LR
    state Proposta {
        [*] --> pendente
        pendente --> aceito: aceitar
        pendente --> recusado: recusar
        aceito --> [*]
        recusado --> [*]
    }
```

```mermaid
stateDiagram-v2
    direction LR
    state Viagem {
        [*] --> em_andamento: proposta aceita
        em_andamento --> concluida: finalizar
        em_andamento --> cancelada: cancelar
        concluida --> [*]
        cancelada --> [*]
    }
```

```mermaid
stateDiagram-v2
    direction LR
    state Pedido {
        [*] --> aberto
        aberto --> atendido: proposta aceita
        aberto --> cancelado: passageiro cancela / expira
        atendido --> [*]
        cancelado --> [*]
    }
    state Carona {
        [*] --> ativa
        ativa --> concluida: viagem finalizada
        ativa --> cancelada: motorista remove / sai do ar
        concluida --> [*]
        cancelada --> [*]
    }
```

Os valores de status são impostos por `CHECK` no `schema.sql` — novos códigos devem
usar exatamente esses literais.
