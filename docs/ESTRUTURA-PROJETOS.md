# Estrutura multi-projeto (um app, vários canteiros)

O VAP **não** duplica o app. Há um único front (`dashboard.html` / `dashboard.js`) e
uma única API. Cada canteiro é um **módulo de dados**:

| Peça | Onde | O que define |
|------|------|----------------|
| Projeto | tabela `projetos` | código, nome, ativo, contrato |
| Usuários | `usuarios.projeto_id` | a qual canteiro a pessoa pertence |
| Isolamento | SQL `AND u.projeto_id = $pid` | carona/mapa/fila só do canteiro |
| Locais | `public/locais-favoritos.json` → `projetos.<CODIGO>` | lista calibrada daquele site |

## Projetos com estrutura pronta

Rodar (com `DATABASE_URL` no `.env`):

```bash
node scripts/garantir-estrutura-projetos.js
```

Isso garante no **banco** e no **JSON** as chaves:

- `S11D` — já calibrado (53 locais)
- `SALOBO`, `CARAJAS`, `PARAUAPEBAS`, `SOSSEGO`, `ONCA-PUMA` — esqueleto (grupos vazios)

## Só preencher locais (sem novo app)

Edite `public/locais-favoritos.json`, na chave do canteiro:

```json
"ONCA-PUMA": {
  "nome": "Onça Puma",
  "regiao": { "lat": -6.75, "lng": -51.08, "raio_km": 40 },
  "grupos": [
    {
      "titulo": "Acessos e apoio",
      "locais": [
        {
          "nome": "Portaria Onça Puma",
          "busca": "Portaria Onça Puma",
          "ref": { "lat": -6.75, "lng": -51.08 },
          "google": false
        }
      ]
    }
  ]
}
```

Opcional — validar nomes no Google Places:

```bash
GOOGLE_MAPS_API_KEY=... node scripts/verificar-locais.js --write
```

Depois: deploy do `public/` (Render). Usuários com `projeto_codigo = ONCA-PUMA` passam a ver a lista.

## O que NÃO precisa

- Novo repositório / novo APK por canteiro  
- Copiar o `dashboard.js`  
- “Passar por todos os projetos” no match (cada request usa só o `projeto_id` do logado)

## Liberar um canteiro

1. Projeto ativo no banco (script ou `dono.html`)  
2. Preencher locais no JSON  
3. Cadastrar / migrar usuários com aquele `projeto_id`  
4. (Opcional) Aprovar admin de canteiro no `dono.html`  
